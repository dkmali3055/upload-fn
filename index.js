const { Storage } = require("@google-cloud/storage");
const Busboy = require("busboy");
const os = require("os");
const path = require("path");
const fs = require("fs");

const storage = new Storage();
const BUCKET_NAME = process.env.BUCKET_NAME; // set at deploy

exports.uploadFile = (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Only POST allowed");
    return;
  }

  const contentType = req.headers["content-type"] || "";
  if (!contentType.startsWith("multipart/form-data")) {
    res.status(400).send("Content-Type must be multipart/form-data");
    return;
  }

  const busboy = new Busboy({ headers: req.headers });
  const uploads = []; // promises
  let fileSaved = false;

  busboy.on("file", (fieldname, file, filename, encoding, mimetype) => {
    // accept field name 'file' (client must use this)
    const ext = path.extname(filename) || "";
    const tmpdir = os.tmpdir();
    const tempFilePath = path.join(tmpdir, `${Date.now()}-${filename}`);
    const writeStream = fs.createWriteStream(tempFilePath);
    file.pipe(writeStream);

    const promise = new Promise((resolve, reject) => {
      writeStream.on("finish", async () => {
        try {
          const destination = filename; // or prefix as needed
          await storage.bucket(BUCKET_NAME).upload(tempFilePath, {
            destination,
            metadata: { contentType: mimetype },
          });
          fs.unlinkSync(tempFilePath);
          fileSaved = true;
          resolve({ filename: destination });
        } catch (err) {
          reject(err);
        }
      });
      writeStream.on("error", reject);
    });

    uploads.push(promise);
  });

  busboy.on("finish", async () => {
    try {
      if (uploads.length === 0) {
        res
          .status(400)
          .send('No file uploaded (form field name must be "file")');
        return;
      }
      const results = await Promise.all(uploads);
      res.status(200).json({ uploaded: results });
    } catch (err) {
      console.error(err);
      res.status(500).send("Upload failed: " + err.message);
    }
  });

  // If running on Cloud Functions Gen1/GCF, use req.rawBody for busboy
  busboy.end(req.rawBody || req); // GCF provides rawBody; local testing may use streams
};
