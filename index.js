// index.js
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const app = express();
app.set("trust proxy", 1);

// Upload config
const upload = multer({
  dest: "/tmp",
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
});

// Request log
app.use((req, _res, next) => {
  console.log(new Date().toISOString(), req.method, req.url);
  next();
});

app.get("/", (_req, res) => res.send("OK"));

/**
 * id -> { path, createdAt }
 */
const downloads = new Map();
const DOWNLOAD_TTL_MS = 10 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, info] of downloads.entries()) {
    if (now - info.createdAt > DOWNLOAD_TTL_MS) {
      fs.unlink(info.path, () => {});
      downloads.delete(id);
      console.log("CLEANUP expired", id);
    }
  }
}, 60 * 1000);

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

    const outPath = path.join(
      "/tmp",
      `output-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`
    );

    // ✅ Important : -loglevel info pendant debug (tu pourras remettre "error" après)
    const args = [
      "-y",
      "-nostdin",
      "-hide_banner",
      "-loglevel", "info",
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
      outPath,
    ];

    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    console.log("FFMPEG STARTED pid=", ff.pid);

    // 🔒 Verrou : une seule réponse possible
    let responded = false;

    // Garder un petit buffer d’erreur + loguer quelques lignes
    let errTail = "";
    let lineCount = 0;
    ff.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      errTail += s;
      if (errTail.length > 12000) errTail = errTail.slice(-12000);

      // Log seulement les ~25 premières lignes pour voir où ça bloque
      if (lineCount < 25) {
        console.log("[ffmpeg]", s.trim());
        lineCount += (s.match(/\n/g) || []).length + 1;
      }
    });

    const safeRespond = (status, payload) => {
      if (responded || res.headersSent) return;
      responded = true;
      res.status(status).json(payload);
    };

    // Watchdog : 60s suffisent largement pour 3–5 min d’audio
    const watchdog = setTimeout(() => {
      console.error("FFMPEG TIMEOUT -> killing process", ff.pid);
      try { ff.kill("SIGKILL"); } catch {}
      cleanupFiles([audioPath, imagePath, outPath]);
      safeRespond(504, { error: "ffmpeg_timeout" });
    }, 60000);

    ff.on("error", (err) => {
      clearTimeout(watchdog);
      console.error("ffmpeg spawn error:", err);
      cleanupFiles([audioPath, imagePath, outPath]);
      safeRespond(500, { error: "ffmpeg_spawn_failed" });
    });

    ff.on("close", (code, signal) => {
      clearTimeout(watchdog);

      console.log("FFMPEG CLOSED code=", code, "signal=", signal);

      // Si le watchdog a déjà répondu, on sort sans rien renvoyer
      if (responded || res.headersSent) {
        cleanupFiles([audioPath, imagePath, outPath]);
        return;
      }

      // Toujours supprimer les inputs
      cleanupFiles([audioPath, imagePath]);

      if (code !== 0) {
        console.error("ffmpeg failed, code:", code, "signal:", signal);
        cleanupFiles([outPath]);
        return safeRespond(500, {
          error: "ffmpeg_failed",
          code,
          signal,
          details: errTail.slice(-4000),
        });
      }

      const id = `dl-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      downloads.set(id, { path: outPath, createdAt: Date.now() });

      const proto = req.get("x-forwarded-proto") || req.protocol || "https";
      const host = req.get("host");
      const url = `${proto}://${host}/download/${id}`;

      console.log("FFMPEG OK ->", id, url);

      safeRespond(200, {
        url,
        id,
        expires_in_seconds: Math.floor(DOWNLOAD_TTL_MS / 1000),
      });
    });
  }
);

app.get("/download/:id", (req, res) => {
  const info = downloads.get(req.params.id);
  if (!info) return res.status(404).send("Not Found");

  fs.stat(info.path, (err, stat) => {
    if (err || !stat?.isFile()) {
      downloads.delete(req.params.id);
      return res.status(404).send("Not Found");
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="output.mp4"');
    res.setHeader("Content-Length", stat.size);

    const stream = fs.createReadStream(info.path);
    stream.on("error", () => res.end());
    stream.pipe(res);
  });
});

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
