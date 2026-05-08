require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");
const bodyParser = require("body-parser");
const cors = require("cors");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const app = express();

app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));
app.use(express.static("public"));

const uploadDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const upload = multer({ dest: "uploads/" });

let isRunning = false;

const growthEmail = process.env.EMAIL_USER;

/* ---------------- SMTP CONFIG ---------------- */

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,

  pool: true,
  maxConnections: 1,
  maxMessages: 20,

  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },

  tls: {
    rejectUnauthorized: false,
  },

  connectionTimeout: 120000,
  greetingTimeout: 120000,
  socketTimeout: 120000,
});

/* ---------------- VERIFY SMTP ---------------- */

transporter.verify((error, success) => {
  if (error) {
    console.log("SMTP ERROR:", error);
  } else {
    console.log("SMTP SERVER READY");
  }
});

/* ---------------- HELPERS ---------------- */

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function personalize(text, data) {
  return text.replace(/{{(.*?)}}/g, (_, key) => data[key.trim()] || "");
}

async function sendMailWithRetry(mailOptions, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await transporter.sendMail(mailOptions);
    } catch (err) {
      console.log(`Retry ${i + 1}:`, err.message);

      if (i === retries - 1) throw err;

      await sleep(15000);
    }
  }
}

/* ---------------- FILE UPLOAD ---------------- */

app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).send("No file uploaded.");
  }

  const filePath = req.file.path;
  const ext = path.extname(req.file.originalname).toLowerCase();

  console.log(`Received file: ${req.file.originalname} (${ext})`);

  const results = [];

  const processData = (data) => {
    return data.map((item) => {
      const normalizedItem = {};

      for (let key in item) {
        normalizedItem[key.toLowerCase()] = item[key];
      }

      if (normalizedItem.email) {
        const prefix = normalizedItem.email.split("@")[0];
        const firstName = prefix.split(/[._]/)[0];

        normalizedItem.name =
          firstName.charAt(0).toUpperCase() + firstName.slice(1);
      }

      return normalizedItem;
    });
  };

  try {
    if (ext === ".csv") {
      fs.createReadStream(filePath)
        .pipe(csv())
        .on("data", (data) => results.push(data))
        .on("end", () => {
          fs.unlinkSync(filePath);

          const processed = processData(results);

          console.log(`Parsed ${processed.length} records from CSV`);

          res.json(processed);
        });
    } else if (ext === ".xlsx" || ext === ".xls") {
      const workbook = XLSX.readFile(filePath);

      const sheetName = workbook.SheetNames[0];

      const worksheet = workbook.Sheets[sheetName];

      const data = XLSX.utils.sheet_to_json(worksheet);

      fs.unlinkSync(filePath);

      const processed = processData(data);

      console.log(`Parsed ${processed.length} records from Excel`);

      res.json(processed);
    } else {
      fs.unlinkSync(filePath);

      return res
        .status(400)
        .send("Unsupported file format. Upload CSV/XLSX");
    }
  } catch (error) {
    console.error("Upload error:", error);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    res.status(500).send("Error processing file");
  }
});

/* ---------------- START CAMPAIGN ---------------- */

app.post("/start", async (req, res) => {
  const { list, subject, body, mode, delay } = req.body;

  if (!list || list.length === 0) {
    return res.status(400).send("No list provided.");
  }

  if (isRunning) {
    return res.send("Campaign already running...");
  }

  isRunning = true;

  res.send("Campaign started 🚀");

  try {
    const getFinalBody = (item) => {
      const greeting = `Hello ${item.name || "there"},\n\n`;

      return greeting + personalize(body, item);
    };

    if (mode === "single") {
      const item = list[0];

      if (!item.email) {
        throw new Error("Missing email");
      }

      await sendMailWithRetry({
        from: `"Growth Studio" <${growthEmail}>`,
        to: item.email,
        subject,
        text: getFinalBody(item),
      });

      console.log("Single email sent:", item.email);

      isRunning = false;

      return;
    }

    for (let i = 0; i < list.length; i++) {
      if (!isRunning) {
        console.log("Campaign stopped");

        break;
      }

      const item = list[i];

      if (!item.email) {
        console.log("Skipping missing email");

        continue;
      }

      try {
        await sendMailWithRetry({
          from: `"Growth Studio" <${growthEmail}>`,
          to: item.email,
          subject,
          text: getFinalBody(item),
        });

        console.log(`[${i + 1}/${list.length}] SENT: ${item.email}`);

        await sleep((delay || 15) * 1000);
      } catch (err) {
        console.error(
          `FAILED: ${item.email}`,
          err.response || err.message
        );
      }
    }

    console.log("Campaign finished");

    isRunning = false;
  } catch (err) {
    console.error("Campaign error:", err);

    isRunning = false;
  }
});

/* ---------------- STOP CAMPAIGN ---------------- */

app.post("/stop", (req, res) => {
  isRunning = false;

  res.send("Campaign stopped");
});

/* ---------------- FRONTEND ---------------- */

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Growth Studio Email Sender</title>

  <style>
    body {
      font-family: Arial;
      background: #4facfe;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
    }

    .box {
      background: white;
      padding: 20px;
      width: 400px;
      border-radius: 10px;
    }

    input, textarea, select {
      width: 100%;
      margin: 5px 0;
      padding: 8px;
    }

    button {
      width: 32%;
      padding: 10px;
      margin-top: 10px;
    }
  </style>
</head>

<body>

<div class="box">

  <h2>Growth Studio 🚀</h2>

  <input type="file" id="file">

  <select id="mode">
    <option value="bulk">Bulk</option>
    <option value="single">Single</option>
  </select>

  <input id="singleEmail" placeholder="Single Email">

  <input id="subject" placeholder="Subject">

  <textarea id="body" placeholder="Hello {{name}}"></textarea>

  <input id="delay" type="number" value="15" min="10" max="60">

  <button onclick="upload()">Upload</button>
  <button onclick="start()">Start</button>
  <button onclick="stop()">Stop</button>

  <p id="status"></p>

</div>

<script>

let list = [];

async function upload() {

  const fileInput = document.getElementById("file");

  if (!fileInput.files.length) {
    alert("Please select file");

    return;
  }

  const file = fileInput.files[0];

  const formData = new FormData();

  formData.append("file", file);

  document.getElementById("status").innerText = "Uploading...";

  try {

    const res = await fetch("/upload", {
      method: "POST",
      body: formData
    });

    if (!res.ok) {
      throw new Error(await res.text());
    }

    list = await res.json();

    document.getElementById("status").innerText =
      "Loaded " + list.length + " records";

  } catch (err) {

    document.getElementById("status").innerText =
      "Upload failed: " + err.message;
  }
}

async function start() {

  const mode = document.getElementById("mode").value;

  const subject = document.getElementById("subject").value;

  const body = document.getElementById("body").value;

  const delay = document.getElementById("delay").value;

  const singleEmail = document.getElementById("singleEmail").value;

  let finalList = list;

  if (mode === "single") {
    finalList = [{ email: singleEmail }];
  }

  if (!finalList.length) {
    document.getElementById("status").innerText =
      "Upload list first";

    return;
  }

  const res = await fetch("/start", {
    method: "POST",

    headers: {
      "Content-Type": "application/json"
    },

    body: JSON.stringify({
      list: finalList,
      subject,
      body,
      mode,
      delay
    })
  });

  document.getElementById("status").innerText =
    await res.text();
}

async function stop() {

  const res = await fetch("/stop", {
    method: "POST"
  });

  document.getElementById("status").innerText =
    await res.text();
}

</script>

</body>
</html>
  `);
});

/* ---------------- START SERVER ---------------- */

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log("Server is running")
})
