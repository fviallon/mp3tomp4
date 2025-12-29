// index.js
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const app = express();

// Limits help prevent accidental huge uploads from killing free-tier memory.
const upload = multer({
  dest: "/tmp",
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB per file
  },
});

app.get("/", (_req, res) => res.send("OK"));

/**
 * POST /convert
 * multipart/form-data:
 *  - audio: mp3 file
 *  - image: jpg/png file
 *
 * Returns: video/mp4 (image still + audio)
 */
app.post(
  "/convert",
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "image", maxCount: 1 },
  ]),
  (req, res) => {
    const audioFile = req.files?.audio?.[0];
    const imageFile = req.files?.image?.[0];

    if (!audioFile || !imageFile) {
      return res.status(400).json({ error: "Missing 'audio' or 'image' file" });
    }

    const audioPath = audioFile.path;
    const imagePath = imageFile.path;

    // Optional: log sizes for debugging in Render logs
    console.log("audio size:", audioFile.size);
    console.log("image size:", imageFile.size);

    const outPath = path.join("/tmp", `output-${Date.now()}.mp4`);

    // Key points for Render free tier:
    // - use spawn (not exec/execFile) to avoid buffering stdout/stderr in RAM
    // - reduce ffmpeg verbosity
    // - downscale image to reduce memory/CPU
    const args = [
      "-y",
      "-loglevel",
      "error",
      "-loop",
      "1",
      "-i",
      imagePath,
      "-i",
      audioPath,
      "-vf",
      "scale=1280:-2,fps=1",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-tune",
      "stillimage",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-shortest",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outPath,
    ];

    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });

    // Keep a small tail of stderr for debugging without exploding RAM
    let errTail = "";
    ff.stderr.on("data", (chunk) => {
      errTail += chunk.toString();
      if (errTail.length > 6000) errTail = errTail.slice(-6000);
    });

    ff.on("error", (err) => {
      console.error("spawn error:", err);
      cleanupFiles([audioPath, imagePath, outPath]);
      return res.status(500).json({ error: "ffmpeg_spawn_failed" });
    });

    ff.on("close", (code) => {
      if (code !== 0) {
        console.error("ffmpeg failed, code:", code, errTail);
        cleanupFiles([audioPath, imagePath, outPath]);
        return res
          .status(500)
          .json({ error: "ffmpeg_failed", code, details: errTail });
      }

      res.setHeader("Content-Type", "video/mp4");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="output.mp4"'
      );

      const stream = fs.createReadStream(outPath);
      stream.pipe(res);

      stream.on("close", () => {
        cleanupFiles([audioPath, imagePath, outPath]);
      });

      stream.on("error", (e) => {
        console.error("read stream error:", e);
        cleanupFiles([audioPath, imagePath, outPath]);
      });
    });
  }
);

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
