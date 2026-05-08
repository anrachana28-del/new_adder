import 'dotenv/config'
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'

import { createClient } from "redis"
import admin from "firebase-admin"

import { TelegramClient } from "telegram"
import { StringSession } from "telegram/sessions/index.js"
import { Api } from "telegram/tl/api.js"

const app = express()
app.use(express.json())

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ================= REDIS =================
const redis = createClient({ url: process.env.REDIS_URL })

redis.on("error", err => console.log("Redis Error:", err))
await redis.connect()

// ================= FIREBASE =================
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL
})

const db = admin.database()

// ================= MEMORY =================
const clients = {}
const sessions = {}
const accountLock = new Map()

// ================= HELPERS =================
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function normalize(input) {
  if (!input) return null
  let v = input.trim()

  if (v.includes("t.me/")) v = v.split("t.me/")[1]
  if (v.startsWith("@")) v = v.slice(1)

  return v
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
    floodWaitUntil: 0,
    addCount: 0
  })
  i++
}

// ================= ROTATION =================
let index = 0

function getAccount() {
  const now = Date.now()

  const available = accounts.filter(a =>
    a.status === "active" &&
    a.floodWaitUntil < now &&
    !accountLock.get(a.id)
  )

  if (!available.length) return null

  const acc = available[index % available.length]
  index++

  accountLock.set(acc.id, true)
  return acc
}

function unlockAccount(id) {
  accountLock.delete(id)
}

// ================= SESSION =================
async function loadSession(id) {
  if (sessions[id]) return sessions[id]
  return await redis.get(`tg:session:${id}`)
}

async function saveSession(id, session) {
  sessions[id] = session
  await redis.set(`tg:session:${id}`, session)
}

// ================= CLIENT =================
async function getClient(acc) {

  if (clients[acc.id]) {
    try {
      await clients[acc.id].getMe()
      return clients[acc.id]
    } catch {
      delete clients[acc.id]
    }
  }

  const session = await loadSession(acc.id)

  const client = new TelegramClient(
    new StringSession(session || acc.session),
    acc.api_id,
    acc.api_hash,
    { connectionRetries: 3 }
  )

  await client.connect()
  await client.getMe()

  const newSession = client.session.save()
  await saveSession(acc.id, newSession)

  clients[acc.id] = client

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

// ================= GROUP MEMBERS =================
async function getGroupMembers(client, group) {
  try {
    const result = await client.getParticipants(group, { limit: 200 })

    return result
      .filter(m => m.username)
      .map(m => "@" + m.username)

  } catch {
    return []
  }
}

// ================= GROUP INFO =================
app.post("/group-info", async (req, res) => {

  const acc = getAccount()
  if (!acc) return res.json({ status: "failed" })

  try {

    const { targetGroup } = req.body

    const client = await getClient(acc)
    const group = await client.getEntity(targetGroup)

    unlockAccount(acc.id)

    return res.json({
      status: "ok",
      title: group.title || "Unknown",
      username: group.username || null,
      id: group.id.toString(),
      type: group.className || "group"
    })

  } catch (e) {
    unlockAccount(acc.id)

    return res.json({
      status: "failed",
      reason: e.message
    })
  }
})

// ================= SINGLE ADD =================
app.post("/add-member", async (req, res) => {

  const acc = getAccount()
  if (!acc) return res.json({ status: "no account" })

  const { username, targetGroup } = req.body

  try {

    const client = await getClient(acc)

    const user = normalize(username)
    if (!user) {
      unlockAccount(acc.id)
      return res.json({ status: "skipped" })
    }

    const entity = await client.getEntity(user)
    const group = await client.getEntity(targetGroup)

    await client.invoke(
      new Api.channels.InviteToChannel({
        channel: group,
        users: [entity]
      })
    )

    await saveHistory({
      username: user,
      status: "success",
      accountUsed: acc.phone
    })

    unlockAccount(acc.id)

    return res.json({ status: "success" })

  } catch (e) {

    unlockAccount(acc.id)

    return res.json({
      status: "failed",
      reason: e.message
    })
  }
})

// ================= BATCH SYSTEM =================
app.post("/add-batch", async (req, res) => {

  const { users = [], groupLink, targetGroup, startIndex = 0, type } = req.body

  const acc = getAccount()
  if (!acc) return res.json({ status: "no account" })

  const client = await getClient(acc)

  let list = []

  try {

    // GROUP MODE
    if (type === "group" || groupLink) {

      const group = await client.getEntity(groupLink)
      list = await getGroupMembers(client, group)

    } else {

      // USER MODE
      list = users
    }

    const results = []

    for (let i = startIndex; i < list.length; i++) {

      const user = normalize(list[i])
      if (!user) continue

      try {

        const entity = await client.getEntity(user)
        const group = await client.getEntity(targetGroup)

        await client.invoke(
          new Api.channels.InviteToChannel({
            channel: group,
            users: [entity]
          })
        )

        results.push({
          index: i,
          user,
          status: "success"
        })

        await saveHistory({
          username: user,
          status: "success",
          accountUsed: acc.phone
        })

        await sleep(2000)

      } catch {

        results.push({
          index: i,
          user,
          status: "failed"
        })
      }
    }

    unlockAccount(acc.id)

    return res.json({
      status: "done",
      lastIndex: list.length,
      results
    })

  } catch (e) {

    unlockAccount(acc.id)

    return res.json({
      status: "error",
      reason: e.message
    })
  }
})

// ================= STATUS =================
app.get("/account-status", (req, res) => {
  res.json(accounts)
})

// ================= HISTORY =================
app.get("/history", async (req, res) => {
  const snap = await db.ref("history").get()
  res.json(snap.val() || {})
})

// ================= EXPORT =================
app.get("/export/history", async (req, res) => {

  const snap = await db.ref("history").get()
  const data = Object.values(snap.val() || {})

  if (req.query.format === "csv") {
    const { Parser } = await import("json2csv")
    const parser = new Parser()
    return res.attachment("history.csv").send(parser.parse(data))
  }

  res.json(data)
})

app.get("/export/accounts", async (req, res) => {

  if (req.query.format === "csv") {
    const { Parser } = await import("json2csv")
    const parser = new Parser()
    return res.attachment("accounts.csv").send(parser.parse(accounts))
  }

  res.json(accounts)
})

// ================= FRONTEND =================
app.use(express.static(__dirname))

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"))
})

// ================= CLEAN =================
setInterval(() => {
  for (const id in clients) {
    clients[id].getMe().catch(() => delete clients[id])
  }
}, 300000)

// ================= RUN =================
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log("RUNNING ON " + PORT)
})
