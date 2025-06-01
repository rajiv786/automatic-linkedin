// require("dotenv").config();
// const puppeteer = require("puppeteer");
// const fs = require("fs");
// const { google } = require("googleapis");
// const path = require("path");

// // Constants
// const BASE_LINKEDIN_SEARCH = "https://www.linkedin.com/search/results/content/?keywords=";
// const EMAIL_REGEX = /[a-zA-Z0-9]([a-zA-Z0-9._%-]*[a-zA-Z0-9])?@[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}/g;

// // Helpers
// const extractEmails = text =>
//   (text.match(EMAIL_REGEX) || []).filter(
//     email => !email.includes("example.com") && !email.includes("noreply") && !email.includes("test.com")
//   );
// const extractLinks = text => [...new Set((text.match(/https?:\/\/[^\s<>"{}|\\^`\[\]]+/g) || []))];

// // Google Sheets setup
// async function getSheetsClient() {
//   const auth = new google.auth.GoogleAuth({
//     keyFile: path.join(__dirname, "keys.json"),
//     scopes: ["https://www.googleapis.com/auth/spreadsheets"],
//   });
//   const client = await auth.getClient();
//   const sheets = google.sheets({ version: "v4", auth: client });
//   return sheets;
// }

// async function appendToSheet(data) {
//   const sheets = await getSheetsClient();
//   const values = data.map(d => [
//     d.email,
//     d.source,
//     d.postUrl,
//     d.profileLink,
//     d.links.join(" | "),
//     d.postContent || "",
//   ]);

//   await sheets.spreadsheets.values.append({
//     spreadsheetId: process.env.GOOGLE_SHEET_ID,
//     range: "Sheet1!A2",
//     valueInputOption: "USER_ENTERED",
//     resource: { values },
//   });
// }

// // Scroll to end of page
// async function scrollToEnd(page) {
//   let previousHeight = await page.evaluate(() => document.body.scrollHeight);
//   while (true) {
//     await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
//     await new Promise(resolve => setTimeout(resolve, 3000));
//     const newHeight = await page.evaluate(() => document.body.scrollHeight);
//     if (newHeight === previousHeight) break;
//     previousHeight = newHeight;
//   }
// }

// // Roles, Locations, Hashtags
// const roles = [
//   "mern stack developer", "front end developer", "back end developer",
//   "reactjs developer", "nodejs developer", "software engineer",
//   "sde1", "sde2", "full stack developer", "javascript developer", "web developer",
// ];
// const locations = ["Bangalore", "Pune", "Hyderabad", "Noida", "Gurugram", "Delhi"];
// const hashtags = ["#hiring", "#jobopening", "#jobs", "#recruitment", "#career", "#developerjobs", "#jobsearch"];

// const queries = [];
// for (const role of roles) {
//   for (const loc of locations) {
//     for (const tag of hashtags) {
//       queries.push(`hiring for ${role} ${loc} ${tag}`);
//       queries.push(`${role} job in ${loc} ${tag}`);
//       queries.push(`${role} ${loc} ${tag}`);
//       queries.push(`looking for ${role} ${loc} ${tag}`);
//     }
//   }
// }

// // Detect first run (limit to 100)
// const firstRunPath = path.join(__dirname, "first_run.json");
// let runLimit = queries.length;
// try {
//   const firstRun = JSON.parse(fs.readFileSync(firstRunPath, "utf-8"));
//   if (!firstRun.done) {
//     console.log("🚀 First deployment detected! Limiting to 100 queries...");
//     runLimit = 100;
//     fs.writeFileSync(firstRunPath, JSON.stringify({ done: true }, null, 2));
//   }
// } catch (e) {
//   console.warn("⚠️ Could not read first_run.json. Running full queries.");
// }

// // Detect 7 AM IST for filtering
// const istHour = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
// const isMorning = new Date(istHour).getHours() === 7;

// (async () => {
//   const browser = await puppeteer.launch({
//     headless: false,
//     defaultViewport: null,
//     args: ["--start-maximized"],
//   });

//   const page = await browser.newPage();
//   console.log("🔐 Logging in...");
//   await page.goto("https://www.linkedin.com/login");
//   await page.type("#username", process.env.LINKEDIN_EMAIL);
//   await page.type("#password", process.env.LINKEDIN_PASSWORD);
//   await page.click("[type='submit']");
//   await page.waitForNavigation();

//   const foundEmails = [];

//   for (const query of queries.slice(0, runLimit)) {
//     const encodedQuery = encodeURIComponent(query);
//     const searchUrl = `${BASE_LINKEDIN_SEARCH}${encodedQuery}${isMorning ? "&datePosted=past-24h" : ""}&sortBy=date_posted`;

//     console.log(`🔍 Searching: ${query}`);
//     await page.goto(searchUrl, { waitUntil: "networkidle2" });

//     await scrollToEnd(page);

//     const pageText = await page.evaluate(() => document.body.innerText);
//     const emails = extractEmails(pageText);
//     const links = extractLinks(pageText).filter(l => !l.includes("linkedin.com"));

//     emails.forEach(email => {
//       foundEmails.push({
//         email,
//         source: "search_page",
//         postUrl: searchUrl,
//         profileLink: "",
//         links,
//         postContent: "",
//       });
//     });

//     const posts = await page.$$eval("a.app-aware-link", links =>
//       links.map(l => l.href).filter(h => h.includes("/feed/update"))
//     );
//     const allPosts = [...new Set(posts)];
//     console.log(`🧵 Found ${allPosts.length} posts for query.`);

//     for (let i = 0; i < Math.min(allPosts.length, 10); i++) {
//       const url = allPosts[i];
//       const tab = await browser.newPage();
//       try {
//         await tab.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
//         await tab.waitForTimeout(3000);

//         const bodyText = await tab.evaluate(() => document.body.innerText);
//         const postContent = await tab.evaluate(() => {
//           const el = document.querySelector(".feed-shared-update-v2__description") || document.querySelector(".feed-shared-text");
//           return el ? el.innerText : "";
//         });

//         const postEmails = extractEmails(bodyText);
//         const externalLinks = extractLinks(bodyText).filter(l => !l.includes("linkedin.com"));
//         const profileLink = await tab.evaluate(() => {
//           const el = document.querySelector("a[href*='/in/']");
//           return el ? el.href : "";
//         });

//         postEmails.forEach(email => {
//           foundEmails.push({
//             email,
//             source: "post",
//             postUrl: url,
//             profileLink: profileLink || "",
//             links: externalLinks,
//             postContent: postContent.slice(0, 200),
//           });
//         });

//         console.log(`📧 Post ${i + 1}: Found ${postEmails.length} emails.`);
//       } catch (e) {
//         console.warn(`⚠️ Failed to load post: ${url}`);
//       }
//       await tab.close();
//       await new Promise(r => setTimeout(r, 1000));
//     }
//   }

//   console.log(`📤 Saving ${foundEmails.length} emails to Google Sheets...`);
//   await appendToSheet(foundEmails);
//   console.log("✅ Done!");
//   await browser.close();
// })();
require("dotenv").config();
const { chromium } = require("playwright");
const fs = require("fs");
const { google } = require("googleapis");
const path = require("path");

// Constants
const BASE_LINKEDIN_SEARCH = "https://www.linkedin.com/search/results/content/?keywords=";
const EMAIL_REGEX = /[a-zA-Z0-9]([a-zA-Z0-9._%-]*[a-zA-Z0-9])?@[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}/g;

// Helpers
const extractEmails = text =>
  (text.match(EMAIL_REGEX) || []).filter(
    email => !email.includes("example.com") && !email.includes("noreply") && !email.includes("test.com")
  );
const extractLinks = text => [...new Set((text.match(/https?:\/\/[^\s<>"{}|\\^`\[\]]+/g) || []))];

// Google Sheets setup
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, "keys.json"), // Your service account key JSON file path
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  return sheets;
}

async function appendToSheet(data) {
  if (!data.length) {
    console.log("No new data to append.");
    return;
  }
  const sheets = await getSheetsClient();
  const values = data.map(d => [
    d.email,
    d.source,
    d.postUrl,
    d.profileLink,
    d.links.join(" | "),
    d.postContent || "",
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Sheet1!A2",
    valueInputOption: "USER_ENTERED",
    resource: { values },
  });
  console.log(`Appended ${data.length} rows to Google Sheets.`);
}

// Scroll to bottom helper
async function scrollToEnd(page) {
  let previousHeight = await page.evaluate(() => document.body.scrollHeight);
  while (true) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(3000);
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === previousHeight) break;
    previousHeight = newHeight;
  }
}

// Roles, Locations, Hashtags
const roles = [
  "mern stack developer", "front end developer", "back end developer",
  "reactjs developer", "nodejs developer", "software engineer",
  "sde1", "sde2", "full stack developer", "javascript developer", "web developer",
];
const locations = ["Bangalore", "Pune", "Hyderabad", "Noida", "Gurugram", "Delhi"];
const hashtags = ["#hiring", "#jobopening", "#jobs", "#recruitment", "#career", "#developerjobs", "#jobsearch"];

const queries = [];
for (const role of roles) {
  for (const loc of locations) {
    for (const tag of hashtags) {
      queries.push(`hiring for ${role} ${loc} ${tag}`);
      queries.push(`${role} job in ${loc} ${tag}`);
      queries.push(`${role} ${loc} ${tag}`);
      queries.push(`looking for ${role} ${loc} ${tag}`);
    }
  }
}

// Detect first run (limit to 100 queries)
const firstRunPath = path.join(__dirname, "first_run.json");
let runLimit = queries.length;
try {
  const firstRun = JSON.parse(fs.readFileSync(firstRunPath, "utf-8"));
  if (!firstRun.done) {
    console.log("🚀 First deployment detected! Limiting to 100 queries...");
    runLimit = 100;
    fs.writeFileSync(firstRunPath, JSON.stringify({ done: true }, null, 2));
  }
} catch (e) {
  console.warn("⚠️ Could not read first_run.json. Running full queries.");
}

// Detect 7 AM IST for filtering
const istHour = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
const isMorning = new Date(istHour).getHours() === 7;

(async () => {
  const browser = await chromium.launch({
    headless: true, // headless for Render deployment
    args: ["--no-sandbox", "--disable-setuid-sandbox"], // required for many Linux containers like Render
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("🔐 Logging in to LinkedIn...");
  await page.goto("https://www.linkedin.com/login", { waitUntil: "networkidle" });
  await page.fill("#username", process.env.LINKEDIN_EMAIL);
  await page.fill("#password", process.env.LINKEDIN_PASSWORD);
  await Promise.all([
    page.click("[type='submit']"),
    page.waitForNavigation({ waitUntil: "networkidle" }),
  ]);
  console.log("✅ Logged in.");

  const foundEmails = [];

  for (const query of queries.slice(0, runLimit)) {
    const encodedQuery = encodeURIComponent(query);
    const searchUrl = `${BASE_LINKEDIN_SEARCH}${encodedQuery}${isMorning ? "&datePosted=past-24h" : ""}&sortBy=date_posted`;

    console.log(`🔍 Searching: ${query}`);
    await page.goto(searchUrl, { waitUntil: "networkidle" });

    await scrollToEnd(page);

    const pageText = await page.evaluate(() => document.body.innerText);
    const emails = extractEmails(pageText);
    const links = extractLinks(pageText).filter(l => !l.includes("linkedin.com"));

    emails.forEach(email => {
      foundEmails.push({
        email,
        source: "search_page",
        postUrl: searchUrl,
        profileLink: "",
        links,
        postContent: "",
      });
    });

    const posts = await page.$$eval("a.app-aware-link", els =>
      els.map(el => el.href).filter(href => href.includes("/feed/update"))
    );
    const allPosts = [...new Set(posts)];
    console.log(`🧵 Found ${allPosts.length} posts for query.`);

    for (let i = 0; i < Math.min(allPosts.length, 10); i++) {
      const url = allPosts[i];
      const tab = await context.newPage();
      try {
        await tab.goto(url, { waitUntil: "networkidle", timeout: 30000 });
        await tab.waitForTimeout(3000);

        const bodyText = await tab.evaluate(() => document.body.innerText);
        const postContent = await tab.evaluate(() => {
          const el = document.querySelector(".feed-shared-update-v2__description") || document.querySelector(".feed-shared-text");
          return el ? el.innerText : "";
        });

        const postEmails = extractEmails(bodyText);
        const externalLinks = extractLinks(bodyText).filter(l => !l.includes("linkedin.com"));
        const profileLink = await tab.evaluate(() => {
          const el = document.querySelector("a[href*='/in/']");
          return el ? el.href : "";
        });

        postEmails.forEach(email => {
          foundEmails.push({
            email,
            source: "post",
            postUrl: url,
            profileLink: profileLink || "",
            links: externalLinks,
            postContent: postContent.slice(0, 200),
          });
        });

        console.log(`📧 Post ${i + 1}: Found ${postEmails.length} emails.`);
      } catch (e) {
        console.warn(`⚠️ Failed to load post: ${url}`);
      }
      await tab.close();
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log(`📤 Saving ${foundEmails.length} emails to Google Sheets...`);
  await appendToSheet(foundEmails);

  console.log("✅ Done!");
  await browser.close();
})();
