// index.js
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const app = express();
app.set("trust proxy", 1);

/* -------------------------------------------------- */
/* Upload config                                      */
/* -------------------------------------------------- */
const upload = multer({
  dest: "/tmp",
  limits: {
    fileSize: 50 * 1024 * 1024 // 50 MB
  }
});

/* -------------------------------------------------- */
/* Logs (indispensable pour debug Make / Render)      */
/* -------------------------------------------------- */
app.use((req, _res, next) => {
  console.log(new Date().toISOString(), req.method, req.url);
  next();
});

app.get("/", (_req, res) => res.send("OK"));

/* -------------------------------------------------- */
/* Download registry (convert → download)             */
/* -------------------------------------------------- */
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

/* -------------------------------------------------- */
/* POST /convert                                      */
/* -------------------------------------------------- */
app.post(
  "/convert",
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "image", maxCount: 1 }
  ]),
  (req, res) => {
    console.log("START /convert", new Date().toISOString());

    const audioFile = req.files?.audio?.[0];
    const imageFile = req.files?.image?.[0];

    if (!audioFile || !imageFile) {
      return res.status(400).json({ error: "Missing audio or image" });
    }

    const audioPath = audioFile.path;
    const imagePath = imageFile.path;

    console.log("audio size:", audioFile.size);
    console.log("image size:", imageFile.size);

    const outPath = path.join(
      "/tmp",
      `output-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`
    );

    /* -------------------------------------------------- */
    /* FFmpeg args — ULTRA LIGHT CPU (Render free safe)   */
    /* -------------------------------------------------- */
    const args = [
      "-y",
      "-nostdin",
      "-hide_banner",
      "-loglevel", "error",

      "-loop", "1",
      "-i", imagePath,
      "-i", audioPath,

      // Video: ultra light (image fixe)
      "-vf", "scale=854:-2,fps=1,format=yuv420p",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-profile:v", "baseline",
      "-level", "3.0",
      "-x264-params", "bframes=0:ref=1:scenecut=0:subme=0:me=dia:trellis=0",
      "-threads", "1",

      // Audio
      "-c:a", "aac",
      "-b:a", "96k",
      "-ac", "1",

      "-shortest",
      "-movflags", "+faststart",
      outPath
    ];

    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    console.log("FFMPEG STARTED pid=", ff.pid);

    let responded = false;

    const safeRespond = (status, payload) => {
      if (responded || res.headersSent) return;
      responded = true;
      res.status(status).json(payload);
    };

    /* -------------------------------------------------- */
    /* Watchdog (Render free = lent mais pas bloqué)      */
    /* -------------------------------------------------- */
    const watchdog = setTimeout(() => {
      console.error("FFMPEG TIMEOUT -> killing process", ff.pid);
      try { ff.kill("SIGKILL"); } catch {}
      cleanupFiles([audioPath, imagePath, outPath]);
      safeRespond(504, { error: "ffmpeg_timeout" });
    }, 180000); // 3 minutes

    ff.on("error", (err) => {
      clearTimeout(watchdog);
      console.error("ffmpeg spawn error:", err);
      cleanupFiles([audioPath, imagePath, outPath]);
      safeRespond(500, { error: "ffmpeg_spawn_failed" });
    });

    ff.on("close", (code, signal) => {
      clearTimeout(watchdog);

      // Inputs can always be removed
      cleanupFiles([audioPath, imagePath]);

      if (responded || res.headersSent) {
        cleanupFiles([outPath]);
        return;
      }

      if (code !== 0) {
        console.error("ffmpeg failed", { code, signal });
        cleanupFiles([outPath]);
        return safeRespond(500, {
          error: "ffmpeg_failed",
          code,
          signal
        });
      }

      /* -------------------------------------------------- */
      /* Register MP4 for download                          */
      /* -------------------------------------------------- */
      const id = `dl-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      downloads.set(id, { path: outPath, createdAt: Date.now() });

      const proto = req.get("x-forwarded-proto") || req.protocol || "https";
      const host = req.get("host");
      const url = `${proto}://${host}/download/${id}`;

      console.log("FFMPEG OK →", url);

      safeRespond(200, {
        url,
        id,
        expires_in_seconds: Math.floor(DOWNLOAD_TTL_MS / 1000)
      });
    });
  }
);

/* -------------------------------------------------- */
/* GET /download/:id                                  */
/* -------------------------------------------------- */
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

/* -------------------------------------------------- */
/* Errors                                             */
/* -------------------------------------------------- */
app.use((err, _req, res, _next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File too large" });
  }
  console.error("Unhandled error:", err);
  return res.status(500).json({ error: "server_error" });
});

/* -------------------------------------------------- */
/* Utils                                              */
/* -------------------------------------------------- */
function cleanupFiles(paths) {
  for (const p of paths) {
    if (!p) continue;
    fs.unlink(p, () => {});
  }
}

/* -------------------------------------------------- */
/* Server                                             */
/* -------------------------------------------------- */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
