import express from "express";
import multer from "multer";
import { exec } from "child_process";

const app = express();
const upload = multer({ dest: "/tmp" });

app.post(
  "/convert",
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "image", maxCount: 1 }
  ]),
  (req, res) => {
    const audio = req.files.audio[0].path;
    const image = req.files.image[0].path;

    const output = "/tmp/output.mp4";

    const cmd = `
      ffmpeg -y -loop 1 -i ${image} -i ${audio}
      -c:a copy -c:v libx264
      -shortest -pix_fmt yuv420p
      ${output}
    `;

    exec(cmd, () => {
      res.download(output);
    });
  }
);

app.listen(3000);
