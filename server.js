import 'dotenv/config'
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'

import { createClient } from "redis"
import admin from "firebase-admin"

import { TelegramClient, Api } from "telegram"
import { StringSession } from "telegram/sessions/index.js"

// ================= APP =================
const app = express()
app.use(express.json())

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ================= REDIS =================
const redis = createClient({
  url: process.env.REDIS_URL
})

await redis.connect()

// ================= FIREBASE HISTORY =================
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL
})

const db = admin.database()

// ================= MEMORY =================
const clients = {}
const sessions = {}

// ================= HELPERS =================
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function normalizeUsername(input) {
  if (!input) return null
  let u = input.trim()
  if (u.includes("t.me/")) u = u.split("/").pop()
  return u.replace("@", "").trim()
}

// ================= ACCOUNTS =================
const accounts = []

let i = 1
while (process.env[`TG_ACCOUNT_${i}_PHONE`]) {
  accounts.push({
    id: `TG_${i}`,
    phone: process.env[`TG_ACCOUNT_${i}_PHONE`],
    api_id: Number(process.env[`TG_ACCOUNT_${i}_API_ID`]),
    api_hash: process.env[`TG_ACCOUNT_${i}_API_HASH`],
    session: process.env[`TG_ACCOUNT_${i}_SESSION`],
    status: "active",
    addCount: 0,
    floodWaitUntil: null
  })
  i++
}

// ================= ROTATION =================
let index = 0

function getAccount() {
  const now = Date.now()

  const available = accounts.filter(a =>
    a.status === "active" &&
    (!a.floodWaitUntil || a.floodWaitUntil < now)
  )

  if (!available.length) return null

  const acc = available[index % available.length]
  index++

  return acc
}

// ================= SESSION =================
async function loadSession(id) {
  if (sessions[id]) return sessions[id]
  const r = await redis.get(`tg:session:${id}`)
  return r
}

async function saveSession(id, session) {
  sessions[id] = session
  await redis.set(`tg:session:${id}`, session)
}

// ================= CLIENT =================
async function getClient(account) {
  if (clients[account.id]) {
    try {
      await clients[account.id].getMe()
      return clients[account.id]
    } catch {
      delete clients[account.id]
    }
  }

  const session = await loadSession(account.id)

  const client = new TelegramClient(
    new StringSession(session || account.session),
    account.api_id,
    account.api_hash,
    { connectionRetries: 5 }
  )

  await client.connect()
  await client.getMe()

  const newSession = client.session.save()
  await saveSession(account.id, newSession)

  clients[account.id] = client

  return client
}

// ================= HISTORY =================
async function saveHistory(data) {
  await db.ref("history").push({
    ...data,
    timestamp: Date.now()
  })
}

// ================= ADD MEMBER (FIXED CORE) =================
app.post("/add-member", async (req, res) => {
  try {

    const { username, user_id, access_hash, targetGroup } = req.body

    const acc = getAccount()
    if (!acc) {
      return res.json({ status: "failed", reason: "no account" })
    }

    const client = await getClient(acc)

    let group
    try {
      group = await client.getEntity(targetGroup)
    } catch {
      return res.json({ status: "failed", reason: "invalid group" })
    }

    // ================= USER =================
    let user

    const clean = normalizeUsername(username)

    try {
      if (clean) {
        user = await client.getEntity(clean)
      } else {

        // 🔥 FIX: safe BigInt conversion
        user = new Api.InputUser({
          userId: BigInt(user_id),
          accessHash: BigInt(access_hash)
        })
      }
    } catch {
      await saveHistory({
        username,
        user_id,
        status: "skipped",
        reason: "user not found",
        accountUsed: acc.phone
      })

      return res.json({
        status: "skipped",
        reason: "user not found"
      })
    }

    // ================= INVITE =================
    try {
      await client.invoke(
        new Api.channels.InviteToChannel({
          channel: group,
          users: [user]
        })
      )

    } catch (err) {

      const msg = err.message || ""

      // ================= FLOOD WAIT =================
      const flood = msg.match(/FLOOD_WAIT_(\d+)/)

      if (flood) {
        const wait = Number(flood[1])

        acc.status = "floodwait"
        acc.floodWaitUntil = Date.now() + wait * 1000

        await saveHistory({
          username,
          user_id,
          status: "floodwait",
          reason: `FLOOD_WAIT_${wait}`,
          accountUsed: acc.phone
        })

        return res.json({
          status: "floodwait",
          reason: `wait ${wait}s`
        })
      }

      // ================= NORMAL FAILED =================
      await saveHistory({
        username,
        user_id,
        status: "failed",
        reason: msg,
        accountUsed: acc.phone
      })

      return res.json({
        status: "failed",
        reason: msg
      })
    }

    // ================= SUCCESS PATH ONLY =================

    // 🔥 delay ONLY success
    await sleep(15000)

    // ================= VERIFY JOIN =================
    let joined = false

    try {
      await client.getParticipant(group, user)
      joined = true
    } catch {}

    // retry check (safe confirm)
    if (!joined) {
      for (let i = 0; i < 3; i++) {
        await sleep(5000)

        try {
          await client.getParticipant(group, user)
          joined = true
          break
        } catch {}
      }
    }

    // ================= FINAL CHECK =================
    if (!joined) {

      await saveHistory({
        username,
        user_id,
        status: "failed",
        reason: "not confirmed join",
        accountUsed: acc.phone
      })

      return res.json({
        status: "failed",
        reason: "telegram did not confirm join"
      })
    }

    // ================= SUCCESS =================
    acc.addCount++

    await saveHistory({
      username,
      user_id,
      status: "success",
      accountUsed: acc.phone
    })

    return res.json({
      status: "success",
      verified: true,
      accountUsed: acc.phone
    })

  } catch (e) {

    return res.json({
      status: "failed",
      reason: e.message
    })
  }
})

// ================= API =================
app.get("/account-status", (req, res) => {
  res.json(accounts)
})

app.get("/history", async (req, res) => {
  const snap = await db.ref("history").get()
  res.json(snap.val() || {})
})

// ================= FRONTEND =================
app.use(express.static(__dirname))

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"))
})

// ================= CLEAN =================
setInterval(async () => {
  for (const id in clients) {
    try {
      await clients[id].getMe()
    } catch {
      delete clients[id]
    }
  }
}, 300000)

// ================= RUN =================
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log("🚀 RUNNING " + PORT)
})
