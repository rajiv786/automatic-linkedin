require("dotenv").config();
const puppeteer = require("puppeteer");
const fs = require("fs");
const { google } = require("googleapis");
const path = require("path");

// Constants
const BASE_LINKEDIN_SEARCH = "https://www.linkedin.com/search/results/content/?keywords=";
const EMAIL_REGEX = /[a-zA-Z0-9]([a-zA-Z0-9._%-]*[a-zA-Z0-9])?@[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}/g;
const DATE_FILTERS = [
  { key: "past-24h", label: "24h" },
  { key: "past-week", label: "week" },
  { key: "past-month", label: "month" },
];

// Helpers
const extractEmails = text => (text.match(EMAIL_REGEX) || []).filter(
  email => !email.includes("example.com") && !email.includes("noreply") && !email.includes("test.com")
);
const extractLinks = text => [...new Set((text.match(/https?:\/\/[^\s<>"{}|\\^`\[\]]+/g) || []))];

// Google Sheets setup
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, "keys.json"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  return sheets;
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

// Extract profile information
async function extractProfileInfo(page, profileUrl) {
  try {
    console.log(`👤 Extracting profile info from: ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(resolve => setTimeout(resolve, 2000));

    return await page.evaluate(() => {
      const getText = selectors => {
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el && el.innerText.trim()) return el.innerText.trim();
        }
        return "";
      };
      return {
        name: getText([
          'h1.text-heading-xlarge',
          '.pv-text-details__left-panel h1',
          '.ph5 h1',
        ]),
        title: getText([
          '.text-body-medium.break-words',
          '.pv-text-details__left-panel .text-body-medium',
        ]),
        location: getText([
          '.text-body-small.inline.t-black--light.break-words',
          '.pv-text-details__left-panel .text-body-small',
        ]),
      };
    });
  } catch (error) {
    console.warn(`⚠️ Error extracting profile info: ${error.message}`);
    return { name: "", title: "", location: "" };
  }
}

// Follow user
async function followUser(page, profileUrl) {
  try {
    console.log(`🔄 Attempting to follow: ${profileUrl}`);
    if (page.url() !== profileUrl) {
      await page.goto(profileUrl, { waitUntil: "networkidle2", timeout: 30000 });
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    const followResult = await page.evaluate(() => {
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
    if (followResult === "followed") await new Promise(r => setTimeout(r, 2000));
    return followResult;
  } catch (error) {
    console.warn(`⚠️ Error following user: ${error.message}`);
    return "error";
  }
}

// Scroll utility
async function scrollToEnd(page, maxScrolls = 20) {
  console.log("📜 Scrolling...");
  let lastHeight = await page.evaluate(() => document.body.scrollHeight);
  let sameCount = 0;
  for (let i = 0; i < maxScrolls && sameCount < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise(r => setTimeout(r, 3000));
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === lastHeight) {
      sameCount++;
    } else {
      sameCount = 0;
    }
    lastHeight = newHeight;
  }
  console.log("📜 Done scrolling");
}

// Roles, Locations, Hashtags
const roles = [
  "mern stack developer", "front end developer", "back end developer",
  "reactjs developer", "nodejs developer", "software engineer",
  "sde1", "sde2", "full stack developer", "javascript developer", "web developer",
];
const locations = ["Noida", "Gurugram", "Delhi", "Bangalore", "Pune", "Hyderabad"];
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
    '--disable-software-rasterizer',],
  });

  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

  console.log("🔐 Logging in...");
  await page.goto("https://www.linkedin.com/login");
  await page.type("#username", process.env.LINKEDIN_EMAIL);
  await page.type("#password", process.env.LINKEDIN_PASSWORD);
  await page.click("[type='submit']");
  await page.waitForNavigation();

  const foundEmails = [];
  const processedProfiles = new Set();
  const totalQueries = queries.length;

  const ENABLE_FOLLOW = process.env.ENABLE_FOLLOW === "true";
  const EXTRACT_PROFILES = process.env.EXTRACT_PROFILES !== "false";

  const BATCH_SIZE = 1;
  const totalBatches = Math.ceil(totalQueries / BATCH_SIZE);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const batchStart = batchIndex * BATCH_SIZE;
    const batchEnd = Math.min(batchStart + BATCH_SIZE, totalQueries);
    const currentBatch = queries.slice(batchStart, batchEnd);

    console.log(`\n🎯 ======= BATCH ${batchIndex + 1}/${totalBatches} =======`);

    for (let i = 0; i < currentBatch.length; i++) {
      const query = currentBatch[i];
      const encodedQuery = encodeURIComponent(query);

      for (const filter of DATE_FILTERS) {
        const searchUrl = `${BASE_LINKEDIN_SEARCH}${encodedQuery}&datePosted=%22${filter.key}%22&origin=FACETED_SEARCH`;
        console.log(`🔍 Query: "${query}" | Filter: ${filter.label}`);

        try {
          await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 60000 });
          await new Promise(r => setTimeout(r, 2000));
          await scrollToEnd(page, 55);

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

          // Extract posts
          const posts = await page.evaluate(() => {
            const selectors = [
              'a[href*="/feed/update"]',
              'a[href*="/posts/"]',
              '.feed-shared-update-v2 a[href*="/feed/"]',
            ];
            const postLinks = [];
            selectors.forEach(sel => {
              document.querySelectorAll(sel).forEach(el => {
                if (el.href && (el.href.includes("/feed/update") || el.href.includes("/posts/"))) {
                  postLinks.push(el.href);
                }
              });
            });
            return [...new Set(postLinks)];
          });

          const postsToProcess = posts.slice(0, 12);

          for (const url of postsToProcess) {
            const tab = await browser.newPage();
            try {
              await tab.setUserAgent(page.userAgent());
              await tab.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
              await new Promise(r => setTimeout(r, 2000));

              const bodyText = await tab.evaluate(() => document.body.innerText);
              const postContent = await tab.evaluate(() => {
                const selectors = [
                  ".feed-shared-update-v2__description",
                  ".feed-shared-text",
                  ".feed-shared-update-v2__commentary",
                ];
                for (const s of selectors) {
                  const el = document.querySelector(s);
                  if (el?.innerText) return el.innerText;
                }
                return "";
              });

              const postEmails = extractEmails(bodyText);
              const externalLinks = extractLinks(bodyText).filter(l => !l.includes("linkedin.com"));

              const profileLink = await tab.evaluate(() => {
                const sels = [
                  "a[href*='/in/'][data-control-name*='actor']",
                  "a[href*='/in/']:not([href*='/company/'])",
                  ".feed-shared-actor a[href*='/in/']",
                ];
                for (const s of sels) {
                  const el = document.querySelector(s);
                  if (el?.href.includes("/in/")) return el.href;
                }
                return "";
              });

              let profileName = "", profileTitle = "", profileLocation = "", followStatus = "";
              if (profileLink && !processedProfiles.has(profileLink)) {
                processedProfiles.add(profileLink);
                if (EXTRACT_PROFILES) {
                  const p = await extractProfileInfo(tab, profileLink);
                  profileName = p.name;
                  profileTitle = p.title;
                  profileLocation = p.location;
                }
                if (ENABLE_FOLLOW) {
                  followStatus = await followUser(tab, profileLink);
                  await new Promise(r => setTimeout(r, 3000));
                }
              } else if (profileLink) {
                followStatus = "already_processed";
              }

              postEmails.forEach(email => {
                foundEmails.push({
                  email,
                  source: `post_${filter.label}`,
                  postUrl: url,
                  profileLink,
                  profileName,
                  profileTitle,
                  profileLocation,
                  followStatus,
                  links: externalLinks,
                  postContent: postContent.slice(0, 200),
                });
              });
            } catch (err) {
              console.warn(`⚠️ Error post ${url}: ${err.message}`);
            }
            await tab.close();
            await new Promise(r => setTimeout(r, 3000));
          }
        } catch (err) {
          console.error(`❌ Error query "${query}" (${filter.label}): ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 4000));
      }
      await new Promise(r => setTimeout(r, 5000));
    }

    if (foundEmails.length > 0) {
      console.log(`💾 Saving batch ${batchIndex + 1} (${foundEmails.length} emails)...`);
      try {
        await appendToSheet(foundEmails);
        console.log("✅ Saved to Google Sheets");
        foundEmails.length = 0;
      } catch (err) {
        console.error(`❌ Error saving batch: ${err.message}`);
      }
    }
    if (batchIndex < totalBatches - 1) {
      console.log("⏳ Waiting before next batch...");
      await new Promise(r => setTimeout(r, 10000));
    }
  }

  if (foundEmails.length > 0) {
    await appendToSheet(foundEmails);
    console.log("✅ Final save complete");
  }
  console.log(`🎯 Total profiles processed: ${processedProfiles.size}`);
  await browser.close();
})();
