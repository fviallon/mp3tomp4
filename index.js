// index.js
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const app = express();
app.set("trust proxy", 1);

// Prevent accidental large uploads from killing free-tier memory.
const upload = multer({
  dest: "/tmp",
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB per file
  },
});

// Simple request log (helps confirm Make hits the service)
app.use((req, _res, next) => {
  console.log(new Date().toISOString(), req.method, req.url);
  next();
});

app.get("/", (_req, res) => res.send("OK"));

/**
 * In-memory registry of downloadable MP4s
 * id -> { path, createdAt }
 */
const downloads = new Map();

// Housekeeping
const DOWNLOAD_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000;  // every minute

setInterval(() => {
  const now = Date.now();
  for (const [id, info] of downloads.entries()) {
    if (now - info.createdAt > DOWNLOAD_TTL_MS) {
      fs.unlink(info.path, () => {});
      downloads.delete(id);
      console.log("CLEANUP expired", id);
    }
  }
}, CLEANUP_INTERVAL_MS);

/**
 * POST /convert
 * multipart/form-data:
 *  - audio: mp3 file
 *  - image: jpg/png file
 *
 * Returns JSON: { url: "https://.../download/<id>" }
 */
app.post(
  "/convert",
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "image", maxCount: 1 },
  ]),
  (req, res) => {
    console.log("START /convert", new Date().toISOString());

    const audioFile = req.files?.audio?.[0];
    const imageFile = req.files?.image?.[0];

    if (!audioFile || !imageFile) {
      return res.status(400).json({ error: "Missing 'audio' or 'image' file" });
    }

    const audioPath = audioFile.path;
    const imagePath = imageFile.path;

    console.log("audio size:", audioFile.size);
    console.log("image size:", imageFile.size);

    const outPath = path.join("/tmp", `output-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`);

    const args = [
      "-y",
      "-nostdin",
      "-hide_banner",
      "-loglevel", "error",
      "-loop", "1",
      "-i", imagePath,
      "-i", audioPath,
      "-vf", "scale=1280:-2,fps=1",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-tune", "stillimage",
      "-c:a", "aac",
      "-b:a", "128k",
      "-shortest",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outPath
    ];

    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });

    let errTail = "";
    ff.stderr.on("data", (chunk) => {
      errTail += chunk.toString();
      if (errTail.length > 6000) errTail = errTail.slice(-6000);
    });

    // Watchdog: don't let requests hang forever
    const watchdog = setTimeout(() => {
      console.error("FFMPEG TIMEOUT -> killing process", ff.pid);
      try { ff.kill("SIGKILL"); } catch {}
      cleanupFiles([audioPath, imagePath, outPath]);
      if (!res.headersSent) res.status(504).json({ error: "ffmpeg_timeout" });
    }, 120000);

    ff.on("error", (err) => {
      clearTimeout(watchdog);
      console.error("ffmpeg spawn error:", err);
      cleanupFiles([audioPath, imagePath, outPath]);
      if (!res.headersSent) res.status(500).json({ error: "ffmpeg_spawn_failed" });
    });

    ff.on("close", (code, signal) => {
      clearTimeout(watchdog);

      // Always delete inputs once ffmpeg is done (success or fail)
      cleanupFiles([audioPath, imagePath]);

      if (code !== 0) {
        console.error("ffmpeg failed, code:", code, "signal:", signal, errTail);
        cleanupFiles([outPath]);
        return res.status(500).json({ error: "ffmpeg_failed", code, signal, details: errTail });
      }

      // Register MP4 for download
      const id = `dl-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      downloads.set(id, { path: outPath, createdAt: Date.now() });

      // Build absolute URL (works behind proxies like Render)
      const proto = req.get("x-forwarded-proto") || req.protocol || "https";
      const host = req.get("host");
      const url = `${proto}://${host}/download/${id}`;

      console.log("FFMPEG OK ->", id, "URL:", url);

      return res.json({ url, id, expires_in_seconds: Math.floor(DOWNLOAD_TTL_MS / 1000) });
    });
  }
);

/**
 * GET /download/:id
 * Streams the MP4 file.
 */
app.get("/download/:id", (req, res) => {
  const id = req.params.id;
  const info = downloads.get(id);

  if (!info) {
    return res.status(404).send("Not Found");
  }

  fs.stat(info.path, (err, stat) => {
    if (err || !stat?.isFile()) {
      downloads.delete(id);
      return res.status(404).send("Not Found");
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="output.mp4"');
    res.setHeader("Content-Length", stat.size);

    const stream = fs.createReadStream(info.path);

    stream.on("error", (e) => {
      console.error("download stream error:", e);
      return res.end();
    });

    // Keep it available for TTL (default) even after download.
    // If you prefer one-shot downloads, uncomment below to delete after sending:
    //
    // res.on("finish", () => {
    //   fs.unlink(info.path, () => {});
    //   downloads.delete(id);
    // });

    stream.pipe(res);
  });
});

// Multer error handler (e.g., file too large)
app.use((err, _req, res, _next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File too large" });
  }
  console.error("Unhandled error:", err);
  return res.status(500).json({ error: "server_error" });
});

function cleanupFiles(paths) {
  for (const p of paths) {
    if (!p) continue;
    fs.unlink(p, () => {});
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
