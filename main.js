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

// 🔐 Growth Studio Gmail (INIT HERE)
const growthEmail = process.env.EMAIL_USER;

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: growthEmail,
    pass: process.env.EMAIL_PASS, // Gmail App Password
  },
});

// 🧠 helper
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

function personalize(text, data) {
  return text.replace(/{{(.*?)}}/g, (_, key) => data[key.trim()] || "");
}

/* ---------------- FILE UPLOAD (CSV/XLSX) ---------------- */
app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    console.log("No file received in /upload");
    return res.status(400).send("No file uploaded.");
  }

  const filePath = req.file.path;
  const ext = path.extname(req.file.originalname).toLowerCase();
  console.log(`Received file: ${req.file.originalname} (${ext})`);

  const results = [];

  const processData = (data) => {
    return data.map(item => {
      // Ensure keys are lowercase for easier access
      const normalizedItem = {};
      for (let key in item) {
        normalizedItem[key.toLowerCase()] = item[key];
      }
      
      // Extract "first name" from email prefix
      if (normalizedItem.email) {
        const prefix = normalizedItem.email.split("@")[0];
        // Take only the first part before a dot or underscore if it exists
        const firstName = prefix.split(/[._]/)[0];
        // Capitalize first letter
        normalizedItem.name = firstName.charAt(0).toUpperCase() + firstName.slice(1);
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
      console.log(`Unsupported format: ${ext}`);
      res.status(400).send("Unsupported file format. Please upload CSV or XLSX.");
    }
  } catch (error) {
    console.error("Upload error:", error);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.status(500).send("Error processing file: " + error.message);
  }
});

/* ---------------- START CAMPAIGN ---------------- */
app.post("/start", async (req, res) => {
  const { list, subject, body, mode, delay } = req.body;

  if (!list || list.length === 0) return res.status(400).send("No list provided.");
  if (isRunning) return res.send("Already running...");
  
  isRunning = true;
  res.send("Campaign started 🚀");

  const getFinalBody = (item) => {
    const greeting = `Hello ${item.name || "there"},\n\n`;
    return greeting + personalize(body, item);
  };

  try {
    if (mode === "single") {
      const item = list[0];
      if (!item.email) throw new Error("Missing email in list");

      // Ensure name is present for single email if not provided
      if (!item.name && item.email) item.name = item.email.split("@")[0];

      await transporter.sendMail({
        from: `"Shivam Panseja" <${growthEmail}>`,
        to: item.email,
        subject,
        text: getFinalBody(item),
      });

      console.log("Single email sent to:", item.email);
      isRunning = false;
      return;
    }

    for (let i = 0; i < list.length; i++) {
      if (!isRunning) break;

      const item = list[i];
      if (!item.email) {
        console.log("Skipping item missing email:", item);
        continue;
      }

      try {
        await transporter.sendMail({
          from: `"Growth Studio" <${growthEmail}>`,
          to: item.email,
          subject,
          text: getFinalBody(item),
        });
        console.log(`[${i+1}/${list.length}] Sent:`, item.email);

        await sleep(delay * 1000); 

      } catch (err) {
        console.error("Failed to send to:", item.email, err.message);
      }
    }

    console.log("Campaign finished");
    isRunning = false;

  } catch (e) {
    console.error("Campaign error:", e);
    isRunning = false;
  }
});

/* ---------------- STOP CAMPAIGN ---------------- */
app.post("/stop", (req, res) => {
  isRunning = false;
  res.send("Stopped");
});

/* ---------------- FRONTEND ---------------- */
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Growth Studio Email Sender</title>
  <style>
    body { font-family: Arial; background:#4facfe; display:flex; justify-content:center; align-items:center; height:100vh; }
    .box { background:white; padding:20px; width:400px; border-radius:10px; }
    input, textarea, select { width:100%; margin:5px 0; padding:8px; }
    button { width:32%; padding:10px; margin-top:10px; }
  </style>
</head>
<body>

<div class="box">
  <h2>Growth Studio 🚀</h2>

  <input type="file" id="file"><br>

  <select id="mode">
    <option value="bulk">Bulk</option>
    <option value="single">Single</option>
  </select>

  <input id="singleEmail" placeholder="Single Email">

  <input id="subject" placeholder="Subject">

  <textarea id="body" placeholder="Hello {{name}}"></textarea>

  <input id="delay" type="number" value="5" min="5" max="60">

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
    alert("Please select a file first");
    return;
  }
  const file = fileInput.files[0];
  const formData = new FormData();
  formData.append("file", file);

  document.getElementById("status").innerText = "Uploading...";
  
  try {
    const res = await fetch("/upload", { method:"POST", body:formData });
    if (!res.ok) throw new Error(await res.text());
    
    list = await res.json();
    console.log("Loaded list:", list);
    document.getElementById("status").innerText = "Successfully Loaded: " + list.length + " records";
  } catch (err) {
    console.error("Upload error:", err);
    document.getElementById("status").innerText = "Upload failed: " + err.message;
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

  console.log("Starting with list:", finalList);

  if (!finalList || finalList.length === 0) {
    document.getElementById("status").innerText = "Error: No data loaded. Please upload a file first.";
    return;
  }

  const res = await fetch("/start", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ list: finalList, subject, body, mode, delay })
  });

  const result = await res.text();
  document.getElementById("status").innerText = result;
}

async function stop() {
  const res = await fetch("/stop", { method:"POST" });
  document.getElementById("status").innerText = await res.text();
}
</script>

</body>
</html>
  `);
});

/* ---------------- START SERVER ---------------- */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Growth Studio running on http://localhost:${PORT}`);
});