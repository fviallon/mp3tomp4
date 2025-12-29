// index.js
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const app = express();

// Prevent accidental large uploads from killing free-tier memory.
const upload = multer({
  dest: "/tmp",
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB per file
  },
});

// Log every request (super useful to confirm Make actually hits the service)
app.use((req, _res, next) => {
  console.log(new Date().toISOString(), req.method, req.url);
  next();
});

app.get("/", (_req, res) => res.send("OK"));

/**
 * POST /convert
 * multipart/form-data:
 *  - audio: mp3 file
 *  - image: jpg/png file
 *
 * Returns: video/mp4 (still image + audio)
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

    // Debug sizes (helps spot oversized covers etc.)
    console.log("audio size:", audioFile.size);
    console.log("image size:", imageFile.size);

    const outPath = path.join("/tmp", `output-${Date.now()}.mp4`);

    // Keep ffmpeg light & quiet (avoids RAM spikes from logs)
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
      console.error("ffmpeg spawn error:", err);
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

      console.log("FFMPEG OK, sending mp4", new Date().toISOString());

      // Important for Make: send Content-Length (some clients dislike unknown-length streams)
      fs.stat(outPath, (err, stat) => {
        if (err) {
          console.error("stat failed:", err);
          cleanupFiles([audioPath, imagePath, outPath]);
          return res.status(500).json({ error: "stat_failed" });
        }

        res.setHeader("Content-Type", "video/mp4");
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="output.mp4"'
        );
        res.setHeader("Content-Length", stat.size);

        // Cleanup after the response is truly finished
        res.on("finish", () => {
          console.log("RESPONSE FINISHED", new Date().toISOString());
          cleanupFiles([audioPath, imagePath, outPath]);
        });

        const stream = fs.createReadStream(outPath);
        stream.on("error", (e) => {
          console.error("read stream error:", e);
          cleanupFiles([audioPath, imagePath, outPath]);
          try {
            res.end();
          } catch {}
        });

        stream.pipe(res);
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
