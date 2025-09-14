require("dotenv").config();
const puppeteer = require("puppeteer");
const fs = require("fs");
const { google } = require("googleapis");
const path = require("path");

// ==================== CONSTANTS ====================
const BASE_LINKEDIN_SEARCH = "https://www.linkedin.com/search/results/content/?keywords=";
const EMAIL_REGEX = /[a-zA-Z0-9]([a-zA-Z0-9._%-]*[a-zA-Z0-9])?@[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}/g;
const DATE_FILTERS = [
  { key: "past-24h", label: "24h" },
  { key: "past-week", label: "week" },
  { key: "past-month", label: "month" },
];

// Daily safety cap
const DAILY_PROFILE_LIMIT = 50;

// User Agents for rotation
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/118.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) Chrome/119.0.0.0 Safari/537.36"
];

// ==================== HELPERS ====================
const randomWait = (min = 2000, max = 5000) =>
  new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));

const extractEmails = text => (text.match(EMAIL_REGEX) || []).filter(
  email => !email.includes("example.com") && !email.includes("noreply") && !email.includes("test.com")
);

const extractLinks = text => [...new Set((text.match(/https?:\/\/[^\s<>"{}|\\^`\[\]]+/g) || []))];

// ==================== GOOGLE SHEETS ====================
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, "keys.json"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

async function appendToSheet(data) {
  const sheets = await getSheetsClient();
  const values = data.map(d => [
    d.email,
    d.source,
    d.postUrl,
    d.profileLink,
    d.profileName || "",
    d.profileTitle || "",
    d.profileLocation || "",
    d.followStatus || "",
    d.links.join(" | "),
    d.postContent || "",
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Sheet1!A2",
    valueInputOption: "USER_ENTERED",
    resource: { values },
  });
}

// ==================== PROFILE FUNCTIONS ====================
async function extractProfileInfo(page, profileUrl) {
  try {
    console.log(`👤 Extracting profile info: ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await randomWait(2000, 4000);

    return await page.evaluate(() => {
      const getText = selectors => {
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el && el.innerText.trim()) return el.innerText.trim();
        }
        return "";
      };
      return {
        name: getText(['h1.text-heading-xlarge', '.pv-text-details__left-panel h1']),
        title: getText(['.text-body-medium.break-words', '.pv-text-details__left-panel .text-body-medium']),
        location: getText(['.text-body-small.inline.t-black--light.break-words']),
      };
    });
  } catch (error) {
    console.warn(`⚠️ Profile extraction failed: ${error.message}`);
    return { name: "", title: "", location: "" };
  }
}

async function followUser(page, profileUrl) {
  try {
    console.log(`🔄 Following attempt: ${profileUrl}`);
    if (page.url() !== profileUrl) {
      await page.goto(profileUrl, { waitUntil: "networkidle2", timeout: 30000 });
      await randomWait(2000, 4000);
    }
    return await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const button of buttons) {
        const text = button.innerText?.toLowerCase() || "";
        if (text.includes("follow") && !text.includes("following") && !text.includes("unfollow")) {
          button.click();
          return "followed";
        }
        if (text.includes("following")) return "already_following";
      }
      return "no_follow_button";
    });
  } catch (error) {
    console.warn(`⚠️ Follow failed: ${error.message}`);
    return "error";
  }
}

// ==================== SCROLL ====================
async function scrollToEnd(page, maxScrolls = 20) {
  console.log("📜 Human-like scrolling...");
  let lastHeight = await page.evaluate(() => document.body.scrollHeight);

  for (let i = 0; i < maxScrolls; i++) {
    await page.evaluate(() => {
      const distance = Math.floor(Math.random() * 500) + 300;
      window.scrollBy(0, distance);
    });
    await randomWait(1000, 4000);

    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === lastHeight) break;
    lastHeight = newHeight;
  }
}

// ==================== QUERIES ====================
const roles = ["mern stack developer", "front end developer", "back end developer"];
const locations = ["Noida", "Gurugram", "Delhi"];
const hashtags = ["#hiring", "#jobopening", "#jobs"];

const queries = [];
for (const role of roles) {
  for (const loc of locations) {
    for (const tag of hashtags) {
      queries.push(`hiring for ${role} ${loc} ${tag}`);
      queries.push(`${role} job in ${loc} ${tag}`);
    }
  }
}

// ==================== MAIN ====================
(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: '/snap/bin/chromium',
    defaultViewport: null,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
    ],
  });

  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]);

  // Login
  console.log("🔐 Logging in...");
  await page.goto("https://www.linkedin.com/login");
  await page.type("#username", process.env.LINKEDIN_EMAIL);
  await page.type("#password", process.env.LINKEDIN_PASSWORD);
  await page.click("[type='submit']");
  await page.waitForNavigation();

  const foundEmails = [];
  const processedProfiles = new Set();

  for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
    const query = queries[queryIndex];
    const encodedQuery = encodeURIComponent(query);

    if (processedProfiles.size >= DAILY_PROFILE_LIMIT) {
      console.log("🚫 Daily profile cap reached.");
      break;
    }

    // Take random break every 3 queries
    if (queryIndex > 0 && queryIndex % 3 === 0) {
      console.log("😴 Taking a break...");
      await randomWait(30000, 60000);
    }

    for (const filter of DATE_FILTERS) {
      const searchUrl = `${BASE_LINKEDIN_SEARCH}${encodedQuery}&datePosted=%22${filter.key}%22&origin=FACETED_SEARCH`;
      console.log(`🔍 Searching: "${query}" | Filter: ${filter.label}`);

      try {
        await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 60000 });
        await randomWait(2000, 4000);
        await scrollToEnd(page, 30);

        const pageText = await page.evaluate(() => document.body.innerText);
        const emails = extractEmails(pageText);
        const links = extractLinks(pageText).filter(l => !l.includes("linkedin.com"));

        emails.forEach(email => {
          foundEmails.push({
            email,
            source: `search_page_${filter.label}`,
            postUrl: searchUrl,
            profileLink: "",
            profileName: "",
            profileTitle: "",
            profileLocation: "",
            followStatus: "",
            links,
            postContent: "",
          });
        });

      } catch (err) {
        console.error(`❌ Error query "${query}" (${filter.label}): ${err.message}`);
      }
      await randomWait(3000, 5000);
    }
  }

  if (foundEmails.length > 0) {
    await appendToSheet(foundEmails);
    console.log("✅ Data saved to Google Sheets");
  }

  console.log(`🎯 Profiles processed: ${processedProfiles.size}`);
  await browser.close();
})();
