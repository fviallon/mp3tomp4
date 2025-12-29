import express from "express";
import multer from "multer";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";

const app = express();
const upload = multer({ dest: "/tmp" });

app.get("/", (_req, res) => res.send("OK"));

app.post(
  "/convert",
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "image", maxCount: 1 },
  ]),
  (req, res) => {
    try {
      const audioPath = req.files.audio?.[0]?.path;
      const imagePath = req.files.image?.[0]?.path;

      if (!audioPath || !imagePath) {
        return res.status(400).json({ error: "Missing 'audio' or 'image' file" });
      }

      const outPath = path.join("/tmp", `output-${Date.now()}.mp4`);

      const args = [
        "-y",
        "-loop", "1",
        "-i", imagePath,
        "-i", audioPath,
        "-c:v", "libx264",
        "-tune", "stillimage",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        outPath
      ];

      execFile("ffmpeg", args, (err, _stdout, stderr) => {
        if (err) {
          return res.status(500).json({ error: "ffmpeg_failed", details: stderr?.slice?.(0, 2000) });
        }

        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Disposition", 'attachment; filename="output.mp4"');

        const stream = fs.createReadStream(outPath);
        stream.on("close", () => fs.unlink(outPath, () => {}));
        stream.pipe(res);
      });
    } catch (e) {
      res.status(500).json({ error: "server_error" });
    }
  }
);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
