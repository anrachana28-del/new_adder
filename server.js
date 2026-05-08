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

// ================= FIREBASE (HISTORY ONLY) =================
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

// ================= SESSION =================
async function loadSession(id) {
  if (sessions[id]) return sessions[id]

  const redisSession = await redis.get(`tg:session:${id}`)
  if (redisSession) {
    sessions[id] = redisSession
    return redisSession
  }

  const acc = accounts.find(a => a.id === id)
  return acc?.session || null
}

async function saveSession(id, session) {
  sessions[id] = session

  await redis.set(`tg:session:${id}`, session, {
    EX: 60 * 60 * 24 * 30
  })
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
let lastIndex = 0

function getAccount() {
  const now = Date.now()

  const available = accounts.filter(a =>
    a.status === "active" &&
    (!a.floodWaitUntil || a.floodWaitUntil < now)
  )

  if (!available.length) return null

  const acc = available[lastIndex % available.length]
  lastIndex++

  return acc
}

// ================= TELEGRAM CLIENT =================
async function getClient(account) {
  try {
    const cached = clients[account.id]
    if (cached) {
      await cached.getMe()
      return cached
    }
  } catch {
    delete clients[account.id]
  }

  const sessionString = await loadSession(account.id)
  if (!sessionString) throw new Error("No session")

  const client = new TelegramClient(
    new StringSession(sessionString),
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
  try {
    await db.ref("history").push({
      ...data,
      timestamp: Date.now()
    })
  } catch (e) {
    console.log("History error:", e.message)
  }
}

// ================= AUTO JOIN =================
async function autoJoin(client, group) {
  try {
    await client.getEntity(group)
  } catch {
    try {
      await client.invoke(
        new Api.messages.ImportChatInvite({ hash: group })
      )
    } catch {}
  }
}

// ================= ADD MEMBER =================
app.post("/add-member", async (req, res) => {
  try {
    const { username, user_id, access_hash, targetGroup } = req.body

    const acc = getAccount()
    if (!acc) {
      return res.json({ status: "failed", reason: "No account available" })
    }

    const client = await getClient(acc)

    // ================= GROUP =================
    let group
    try {
      group = await client.getEntity(targetGroup)
    } catch {
      return res.json({ status: "failed", reason: "Invalid group" })
    }

    // ================= USER =================
    let userEntity

    try {
      const clean = normalizeUsername(username)

      if (clean) {
        userEntity = await client.getEntity(clean)
      } else {
        userEntity = new Api.InputUser({
          userId: user_id,
          accessHash: BigInt(access_hash)
        })
      }
    } catch {
      await saveHistory({
        username,
        user_id,
        status: "skipped",
        reason: "User not found",
        accountUsed: acc.phone
      })

      return res.json({ status: "skipped", reason: "user not found" })
    }

    // ================= CHECK EXIST =================
    try {
      await client.getParticipant(group, userEntity)

      await saveHistory({
        username,
        user_id,
        status: "skipped",
        reason: "already in group",
        accountUsed: acc.phone
      })

      return res.json({ status: "skipped", reason: "already in group" })
    } catch {}

    // ================= INVITE =================
    try {
      await client.invoke(
        new Api.channels.InviteToChannel({
          channel: group,
          users: [userEntity]
        })
      )
    } catch (err) {
      return res.json({
        status: "failed",
        reason: err.message
      })
    }

    // ================= WAIT FOR TELEGRAM SYNC =================
    await sleep(15000)

    // ================= VERIFY JOIN =================
    let joined = false

    try {
      await client.getParticipant(group, userEntity)
      joined = true
    } catch {}

    // retry verify
    if (!joined) {
      for (let i = 0; i < 3; i++) {
        await sleep(5000)

        try {
          await client.getParticipant(group, userEntity)
          joined = true
          break
        } catch {}
      }
    }

    // ================= FINAL RESULT =================
    if (!joined) {
      await saveHistory({
        username,
        user_id,
        status: "failed",
        reason: "invite sent but not joined",
        accountUsed: acc.phone
      })

      return res.json({
        status: "failed",
        reason: "NOT CONFIRMED JOIN",
        accountUsed: acc.phone
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
      reason: "verified joined",
      accountUsed: acc.phone
    })

  } catch (e) {
    return res.json({
      status: "failed",
      reason: e.message
    })
  }
})

// ================= APIs =================
app.get("/account-status", (req, res) => {
  res.json(accounts)
})

app.get("/history", async (req, res) => {
  try {
    const snap = await db.ref("history").get()
    res.json(snap.val() || {})
  } catch {
    res.json({})
  }
})

// ================= FRONTEND =================
app.use(express.static(__dirname))

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"))
})

// ================= CLEAN CLIENT =================
setInterval(async () => {
  for (const id in clients) {
    try {
      await clients[id].getMe()
    } catch {
      delete clients[id]
    }
  }
}, 5 * 60 * 1000)

// ================= SERVER =================
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log("🚀 Server running on " + PORT)
})
