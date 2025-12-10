import { Storage } from "@google-cloud/storage";
import Busboy from "busboy";
import os from "os";
import path from "path";
import fs from "fs";
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";

const storage = new Storage();
const docai = new DocumentProcessorServiceClient();

const inputBucket = process.env.BUCKET_NAME;
const outputBucket = process.env.OUTPUT_BUCKET;
const processorId = process.env.PROCESSOR_ID;
const processorLocation = process.env.PROCESSOR_LOCATION; // example: "us" or "us-central1"

export const uploadFile = (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Only POST allowed");
    return;
  }

  const contentType = req.headers["content-type"] || "";
  if (!contentType.startsWith("multipart/form-data")) {
    res.status(400).send("Content-Type must be multipart/form-data");
    return;
  }

  const busboy = Busboy({ headers: req.headers });
  const uploads = [];

  busboy.on("file", (name, file, info) => {
    const { filename, encoding, mimeType } = info;
    const mimetype = mimeType;
    const tempPath = path.join(os.tmpdir(), `${Date.now()}-${filename}`);
    const writeStream = fs.createWriteStream(tempPath);
    file.pipe(writeStream);

    const uploadPromise = new Promise((resolve, reject) => {
      writeStream.on("finish", async () => {
        try {
          const destination = filename;

          // Upload to the input bucket
          await storage.bucket(inputBucket).upload(tempPath, {
            destination,
            metadata: { contentType: mimetype },
          });
          fs.unlinkSync(tempPath);

          // --- Trigger Document AI async job ---
          const gcsInputUri = `gs://${inputBucket}/${destination}`;
          const gcsOutputUri = `gs://${outputBucket}/docai-output/`; // folder prefix

          const request = {
            name: `projects/${process.env.GCLOUD_PROJECT}/locations/${processorLocation}/processors/${processorId}`,
            inputDocuments: {
              gcsDocuments: {
                documents: [
                  {
                    gcsUri: gcsInputUri,
                    mimeType: mimetype,
                  },
                ],
              },
            },
            documentOutputConfig: {
              gcsOutputConfig: {
                gcsUri: gcsOutputUri,
              },
            },
          };

          const [operation] = await docai.batchProcessDocuments(request);

          resolve({
            uploaded: destination,
            docAI_job: operation.name,
            input: gcsInputUri,
            output: gcsOutputUri,
          });
        } catch (err) {
          reject(err);
        }
      });

      writeStream.on("error", reject);
    });

    uploads.push(uploadPromise);
  });

  busboy.on("finish", async () => {
    try {
      if (uploads.length === 0) {
        res.status(400).send("No file uploaded");
        return;
      }
      const result = await Promise.all(uploads);
      res
        .status(200)
        .json({ message: "Uploaded & Document AI job started", result });
    } catch (err) {
      res.status(500).send("Failed: " + err.message);
    }
  });

  busboy.end(req.rawBody);
};
