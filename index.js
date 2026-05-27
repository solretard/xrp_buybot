import xrpl from 'xrpl'
import TelegramBot from 'node-telegram-bot-api'
import fetch from 'node-fetch'
import fs from 'fs'

const BOT_TOKEN  = process.env.BOT_TOKEN || '8716259652:AAFeu_Gl7urlPTiS_SUS4q6ZzRiN4zypZgs'
const CHAT_ID    = process.env.CHAT_ID   || '-1003968691129'
const XRPL_WS    = 'wss://xrplcluster.com'
const IMAGE_PATH = './alert.png'

const bot    = new TelegramBot(BOT_TOKEN, { polling: true })
let client   = null
let tracking = {}
let xrpUsd   = 0.5

async function fetchXrpPrice() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd')
    const d = await r.json()
    xrpUsd = d?.ripple?.usd || xrpUsd
    console.log(`💰 XRP: $${xrpUsd}`)
  } catch {}
}
fetchXrpPrice()
setInterval(fetchXrpPrice, 60_000)

async function fetchTokenData(currency, issuer) {
  try {
    // Try with currency as-is first, then with $ prefix if not present
    const tryTickers = [currency]
    if (!currency.startsWith('$')) tryTickers.push('$' + currency)
    else tryTickers.push(currency.slice(1)) // also try without $

    for (const ticker of tryTickers) {
      const currencyHex = Buffer.from(ticker.padEnd(20, '\0')).toString('hex').toUpperCase()
      const pairAddr = `${currencyHex}.${issuer}_xrp`.toLowerCase()
      const url = `https://api.dexscreener.com/latest/dex/pairs/xrpl/${pairAddr}`
      console.log(`📡 DexScreener: ${url}`)
      const r = await fetch(url)
      const d = await r.json()
      const pair = d?.pair || d?.pairs?.[0] || null
      if (pair) {
        return {
          mcap:        pair.marketCap || pair.fdv || 0,
          price:       parseFloat(pair.priceUsd || 0),
          volume:      pair.volume?.h24 || 0,
          priceChange: pair.priceChange?.h24 || 0,
          holders:     pair.holders || 0,
        }
      }
    }
    console.log('⚠️ DexScreener: no pair found for any ticker variant')
    return null
  } catch (e) {
    console.log(`⚠️ DexScreener error: ${e.message}`)
    return null
  }
}

function buildMCBar(mcap) {
  const MILESTONES = [10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 5_000_000, 10_000_000, 50_000_000, 100_000_000, 500_000_000, 1_000_000_000]
  const FILLED = '🪞', EMPTY = '⬜', BAR_SIZE = 10
  let target = MILESTONES[MILESTONES.length - 1], prevTarget = 0
  for (const m of MILESTONES) { if (mcap < m) { target = m; break } prevTarget = m }
  const progress = Math.min((mcap - prevTarget) / (target - prevTarget), 1)
  const filled = Math.round(progress * BAR_SIZE)
  const bar = FILLED.repeat(filled) + EMPTY.repeat(BAR_SIZE - filled)
  const pct = Math.round(progress * 100)
  const fmt = (n) => n >= 1_000_000 ? `$${(n/1_000_000).toFixed(1)}M` : n >= 1_000 ? `$${(n/1_000).toFixed(0)}K` : `$${n.toFixed(0)}`
  return { bar, pct, target, targetFmt: fmt(target), mcapFmt: fmt(mcap) }
}

function fmtNum(n) {
  if (!n) return '$0'
  if (n >= 1_000_000) return `$${(n/1_000_000).toFixed(2)}M`
  if (n >= 1_000)     return `$${(n/1_000).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

function hexToTicker(hex) {
  try {
    const clean = hex.replace(/00+$/, '')
    return Buffer.from(clean, 'hex').toString('ascii').replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
  } catch { return hex }
}

async function connectXRPL() {
  if (client?.isConnected()) return
  client = new xrpl.Client(XRPL_WS)
  client.on('disconnected', () => {
    console.log('⚠️ Disconnected — reconnecting...')
    setTimeout(() => connectXRPL().catch(console.error), 5000)
  })
  await client.connect()
  console.log('✅ XRPL connected')
  client.on('transaction', async (tx) => {
    try { await handleTx(tx) } catch (e) { console.error('TX error:', e.message) }
  })
}

async function subscribeToken(issuer) {
  await connectXRPL()
  await client.request({ command: 'subscribe', accounts: [issuer] })
  console.log(`📡 Subscribed: ${issuer}`)
}

async function unsubscribeToken(issuer) {
  if (!client?.isConnected()) return
  try { await client.request({ command: 'unsubscribe', accounts: [issuer] }) } catch {}
}

async function handleTx(tx) {
  const t    = tx.transaction || tx
  const meta = tx.meta || t.meta
  if (!meta || meta.TransactionResult !== 'tesSUCCESS') return

  const txType = t.TransactionType
  // ── DEBUG: log every TX so we can see what's coming in ──
  console.log(`📥 TX: ${txType} from ${t.Account}`)
  if (!['Payment', 'OfferCreate', 'AMMSwap'].includes(txType)) return

  const nodes = meta.AffectedNodes || []
  const buyer = t.Account

  for (const key of Object.keys(tracking)) {
    const { currency, issuer, name } = tracking[key]

    // Try both with and without $ prefix for hex matching
    const currencyHex = Buffer.from(currency.padEnd(20, '\0')).toString('hex').toUpperCase()
    const currencyHexDollar = Buffer.from(('$'+currency).padEnd(20, '\0')).toString('hex').toUpperCase()

    let xrpSpent = 0, tokensReceived = 0, isNewHolder = false

    for (const node of nodes) {
      const isCreated = !!node.CreatedNode
      const entry = node.ModifiedNode || node.CreatedNode || node.DeletedNode
      if (!entry) continue

      const ltype = entry.LedgerEntryType
      const final = entry.FinalFields || entry.NewFields || {}
      const prev  = entry.PreviousFields || {}

      // ── XRP spent ──
      if (ltype === 'AccountRoot' && final.Account === buyer) {
        const prevBal  = parseInt(prev.Balance  || '0')
        const finalBal = parseInt(final.Balance || '0')
        if (prevBal > 0 && finalBal > 0 && prevBal > finalBal) {
          xrpSpent = (prevBal - finalBal) / 1_000_000
        }
      }

      // ── Tokens received ──
      if (ltype === 'RippleState') {
        const balCur = final.Balance?.currency || ''
        const matches = balCur === currency || balCur === currencyHex || balCur === currencyHexDollar || hexToTicker(balCur) === currency || hexToTicker(balCur) === '$'+currency
        if (!matches) continue

        const prevVal  = parseFloat(prev.Balance?.value  ?? '0')
        const finalVal = parseFloat(final.Balance?.value ?? '0')
        const diff     = finalVal - prevVal

        const lowAcc  = final.LowLimit?.issuer  || ''
        const highAcc = final.HighLimit?.issuer || ''
        const buyerInvolved = lowAcc === buyer || highAcc === buyer
        if (!buyerInvolved) continue

        // ── Log what we see ──
        console.log(`   RippleState match: currency=${balCur} prevVal=${prevVal} finalVal=${finalVal} diff=${diff} buyer=${buyerInvolved}`)

        if (isCreated) {
          tokensReceived = Math.abs(finalVal)
          isNewHolder = true
        } else if (diff > 0 && prevVal >= 0) {
          tokensReceived = diff
        } else if (diff < 0 && prevVal <= 0) {
          tokensReceived = Math.abs(diff)
        } else if (Math.abs(diff) > 0) {
          tokensReceived = Math.abs(diff)
        }
      }
    }

    if (tokensReceived > 0 && xrpSpent > 0.0001) {
      console.log(`🚨 BUY: ${xrpSpent.toFixed(4)} XRP → ${tokensReceived.toFixed(2)} ${name}`)
      await sendBuyAlert({ name, currency, issuer, buyerAddr: buyer, xrpSpent, tokensReceived, txHash: t.hash, isNewHolder })
    }
  }
}

async function sendBuyAlert({ name, currency, issuer, buyerAddr, xrpSpent, tokensReceived, txHash, isNewHolder = false }) {
  const usdVal  = (xrpSpent * xrpUsd).toFixed(2)
  const short   = buyerAddr.slice(0, 6) + '...' + buyerAddr.slice(-4)
  const txLink  = `https://xrpscan.com/tx/${txHash}`
  const buyLink = `https://xrpscan.com/account/${buyerAddr}`
  const flLink  = `https://firstledger.net/token-v2/${issuer}/${currency}`
  const dexLink = `https://dexscreener.com/xrpl/${currency}.${issuer}_xrp`
  const size    = xrpSpent < 10 ? '🐟' : xrpSpent < 100 ? '🐬' : '🐳'
  const newBadge = isNewHolder ? '\n🆕 <b>New Holder!</b>' : ''

  const tokenData = await fetchTokenData(currency, issuer)
  let mcLine = '', barLine = '', volLine = ''
  if (tokenData && tokenData.mcap > 0) {
    const { bar, pct, targetFmt, mcapFmt } = buildMCBar(tokenData.mcap)
    const change = tokenData.priceChange > 0 ? `+${tokenData.priceChange.toFixed(1)}%` : `${tokenData.priceChange.toFixed(1)}%`
    mcLine  = `\n🏦 <b>MCap:</b> ${mcapFmt}  |  <b>${change}</b>`
    volLine = `📊 <b>Vol 24h:</b> ${fmtNum(tokenData.volume)}`
    barLine = `\nNext ${targetFmt}: ${bar} ${pct}%`
  }

  const msg =
`🪞 <b>New BUY — $${name}</b>  ${size}

💙 <b>${xrpSpent.toFixed(2)} XRP</b>  |  <b>$${usdVal}</b>
📈 <b>${tokensReceived.toLocaleString(undefined,{maximumFractionDigits:0})} $${name}</b>
👤 <a href="${buyLink}">${short}</a>  |  <a href="${txLink}">TX ↗</a>${newBadge}${mcLine}
${volLine}${barLine}

<a href="${flLink}">First Ledger</a>  |  <a href="${dexLink}">Chart</a>

<i>$REALITY is the truth. The complete meme. Now on XRPL. 🪞</i>`

  try {
    const opts = {
      caption: msg, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[
        { text: '📊 Chart', url: dexLink },
        { text: '🟢 Buy Now', url: flLink },
        { text: '🔍 TX', url: txLink },
      ]]}
    }
    if (fs.existsSync(IMAGE_PATH)) {
      await bot.sendPhoto(CHAT_ID, IMAGE_PATH, opts)
    } else {
      await bot.sendMessage(CHAT_ID, msg, { parse_mode: 'HTML', disable_web_page_preview: true })
    }
    console.log(`✅ Alert sent`)
  } catch (e) { console.error('Send error:', e.message) }
}

function parseCA(input) {
  const parts = input.trim().split(/[\s+]+/)
  if (parts.length >= 2 && parts[1].startsWith('r') && parts[1].length >= 25) {
    return { currency: parts[0].toUpperCase(), issuer: parts[1] }
  }
  return null
}

// ── Commands ──
bot.onText(/\/start(?:@\w+)?/, msg => {
  bot.sendMessage(msg.chat.id,
`🪞 <b>$REALITY Buy Bot</b>

/track <code>TICKER+rIssuerAddress</code>
/stop <code>TICKER+rIssuerAddress</code>
/stopall
/list
/test
/setimage — Change buy alert image
/addimage — Add image to hourly rotation
/images — Show hourly image count

<i>W.E.H 1921 · XRPL</i>`, { parse_mode: 'HTML' })
})

bot.onText(/\/track(?:@\w+)?\s+(.+)/, async (msg, match) => {
  const parsed = parseCA(match[1])
  if (!parsed) return bot.sendMessage(msg.chat.id, '❌ Format: /track TICKER+rIssuerAddress')
  const { currency, issuer } = parsed
  const key = `${currency}_${issuer}`
  if (tracking[key]) return bot.sendMessage(msg.chat.id, `⚠️ Already tracking <b>$${currency}</b>`, { parse_mode: 'HTML' })
  try {
    await subscribeToken(issuer)
    tracking[key] = { currency, issuer, name: currency, startTime: Date.now() }
    bot.sendMessage(msg.chat.id, `✅ Tracking <b>$${currency}</b>\n\n<code>${issuer}</code>\n\nBuy alerts incoming 🪞`, { parse_mode: 'HTML' })
  } catch (e) { bot.sendMessage(msg.chat.id, `❌ ${e.message}`) }
})

bot.onText(/\/stop(?:@\w+)?\s+(.+)/, async (msg, match) => {
  console.log('🛑 Stop command received:', match[1])
  const parsed = parseCA(match[1])
  if (!parsed) return bot.sendMessage(msg.chat.id, '❌ Format: /stop TICKER+rIssuerAddress')
  const { currency, issuer } = parsed
  const key = `${currency}_${issuer}`
  if (!tracking[key]) return bot.sendMessage(msg.chat.id, `⚠️ Not tracking <b>$${currency}</b>`, { parse_mode: 'HTML' })
  await unsubscribeToken(issuer)
  delete tracking[key]
  bot.sendMessage(msg.chat.id, `🛑 Stopped <b>$${currency}</b>`, { parse_mode: 'HTML' })
})

bot.onText(/\/stopall(?:@\w+)?/, async msg => {
  const count = Object.keys(tracking).length
  if (!count) return bot.sendMessage(msg.chat.id, '⚠️ Nothing tracked.')
  for (const key of Object.keys(tracking)) {
    try { await unsubscribeToken(tracking[key].issuer) } catch {}
    delete tracking[key]
  }
  bot.sendMessage(msg.chat.id, `🛑 Stopped all ${count} token(s).`)
})

bot.onText(/\/list(?:@\w+)?/, msg => {
  const keys = Object.keys(tracking)
  if (!keys.length) return bot.sendMessage(msg.chat.id, '📋 Nothing tracked.')
  const list = keys.map(k => {
    const { currency, issuer, startTime } = tracking[k]
    return `🔵 <b>$${currency}</b> — ${Math.floor((Date.now()-startTime)/60000)}m\n<code>${issuer}</code>`
  }).join('\n\n')
  bot.sendMessage(msg.chat.id, `📋 <b>Tracked:</b>\n\n${list}`, { parse_mode: 'HTML' })
})

bot.onText(/\/test(?:@\w+)?/, async msg => {
  await sendBuyAlert({
    name: 'GRIZ', currency: 'GRIZ',
    issuer: 'rUskFytyiRgLnq8rCUrra91zxQrgR8AFrr',
    buyerAddr: 'rTestBuyerXRPL1234567890ABCD',
    xrpSpent: 25.5, tokensReceived: 4958770,
    txHash: 'FAKEHASH1234567890', isNewHolder: true
  })
  bot.sendMessage(msg.chat.id, '🧪 Test alert sent!')
})

const pendingImageUpload = new Set()
const pendingHourlyImage = new Map()
if (!fs.existsSync('./images')) fs.mkdirSync('./images')

bot.onText(/\/setimage(?:@\w+)?/, async msg => {
  pendingImageUpload.add(msg.chat.id)
  bot.sendMessage(msg.chat.id, '🖼 Send me the new image to use for buy alerts.')
})

async function handlePhoto(chatId, photo) {
  const fileId = photo[photo.length - 1].file_id
  const fileUrl = await bot.getFileLink(fileId)
  const res = await fetch(fileUrl)
  return Buffer.from(await res.arrayBuffer())
}

bot.on('photo', async msg => {
  const chatId = msg.chat.id
  console.log(`📸 Photo received from ${chatId} | pendingUpload=${pendingImageUpload.has(chatId)} | pendingHourly=${pendingHourlyImage.has(chatId)}`)

  if (pendingImageUpload.has(chatId)) {
    pendingImageUpload.delete(chatId)
    try {
      const buf = await handlePhoto(chatId, msg.photo)
      fs.writeFileSync(IMAGE_PATH, buf)
      bot.sendMessage(chatId, '✅ Buy alert image updated!')
      console.log('🖼 Alert image updated')
    } catch (e) { bot.sendMessage(chatId, `❌ Failed to save image: ${e.message}`) }
    return
  }

  if (pendingHourlyImage.has(chatId) && pendingHourlyImage.get(chatId).step === 'image') {
    try {
      const buf = await handlePhoto(chatId, msg.photo)
      const filename = `img_${Date.now()}.jpg`
      pendingHourlyImage.set(chatId, { step: 'caption', buf, filename })
      bot.sendMessage(chatId, '✏️ Now send the caption/message for this image.')
    } catch (e) {
      pendingHourlyImage.delete(chatId)
      bot.sendMessage(chatId, `❌ Failed to get image: ${e.message}`)
    }
    return
  }
})

bot.on('new_chat_members', async (msg) => {
  const newMembers = msg.new_chat_members || []
  for (const member of newMembers) {
    if (member.is_bot) continue
    const name = member.first_name || member.username || 'anon'
    const welcome =
`🪞 Welcome, <b>${name}</b>!

You just stepped into $REALITY.

Not an illusion. Not a hype play.
The complete meme — both faces, one truth.

W.E. Hill drew it in 1921.
We brought it to XRPL in 2025.

<i>$REALITY is the truth. The complete meme. Now on XRPL. 🪞</i>`
    try {
      if (fs.existsSync(IMAGE_PATH)) {
        await bot.sendPhoto(msg.chat.id, IMAGE_PATH, { caption: welcome, parse_mode: 'HTML' })
      } else {
        await bot.sendMessage(msg.chat.id, welcome, { parse_mode: 'HTML' })
      }
    } catch (e) { console.error('Welcome error:', e.message) }
  }
})

const HOURLY_IMAGES_DIR = './images'
const HOURLY_MESSAGES = [
  '🪞 Two faces. One truth. $REALITY on XRPL.',
  '🪞 The first meme in history is now a coin. W.E. Hill, 1921. $REALITY.',
  '💙 How you think your portfolio looks vs how it really looks. $REALITY knows.',
  '🪞 $LUTHER is the illusion. $REALITY is the truth. The complete picture.',
  '📈 Every buy is a vote for reality over illusion. $REALITY on XRPL.',
  '🪞 1921 → 2025. The original duality. Now immortalized on the fastest ledger.',
  '💙 Not a meme. A mirror. $REALITY.',
  '🪞 W.E. Hill saw it coming. The truth always has two faces. $REALITY.',
  '📊 Charts go up. Charts go down. $REALITY stays real. Always.',
  '🪞 The complete meme is live. Both faces. One token. XRPL.',
  '💙 While others chase illusions, $REALITY holders know the truth.',
  '🪞 First meme ever drawn. First CTO narrative on XRPL. $REALITY.',
  '📈 How you think your bags look vs how they really look. $REALITY gets it.',
  '🪞 The truth doesn\'t need hype. It just needs time. $REALITY.',
  '💙 Two panels. One cartoon. 100 years later — now a coin on XRPL. $REALITY.',
  '🪞 Every holder knows which face they are. That\'s the beauty of $REALITY.',
  '📊 Duality is not weakness. It\'s the whole truth. $REALITY.',
  '🪞 The original meme predated the internet. $REALITY lives on the fastest ledger.',
  '💙 You can\'t escape reality. You might as well hold it. $REALITY on XRPL.',
  '🪞 $REALITY — where the illusion ends and the truth begins.',
]

let lastHourlyImage = -1

async function sendHourlyPost() {
  try {
    let imagePath = IMAGE_PATH
    let hourlyCaption = null
    if (fs.existsSync(HOURLY_IMAGES_DIR)) {
      const files = fs.readdirSync(HOURLY_IMAGES_DIR).filter(f => /\.(png|jpg|jpeg|gif|webp|txt)$/i.test(f))
      const imgFiles = files.filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f))
      if (imgFiles.length > 0) {
        let idx
        do { idx = Math.floor(Math.random() * imgFiles.length) }
        while (idx === lastHourlyImage && imgFiles.length > 1)
        lastHourlyImage = idx
        imagePath = `${HOURLY_IMAGES_DIR}/${imgFiles[idx]}`
        const captionFile = imagePath.replace(/\.(jpg|jpeg|png|gif|webp)$/i, '.txt')
        if (fs.existsSync(captionFile)) hourlyCaption = fs.readFileSync(captionFile, 'utf8').trim()
      }
    }
    const msg = hourlyCaption || HOURLY_MESSAGES[Math.floor(Math.random() * HOURLY_MESSAGES.length)]
    if (fs.existsSync(imagePath)) {
      await bot.sendPhoto(CHAT_ID, imagePath, { caption: msg, parse_mode: 'HTML' })
    } else {
      await bot.sendMessage(CHAT_ID, msg, { parse_mode: 'HTML' })
    }
    console.log('⏰ Hourly post sent')
  } catch (e) { console.error('Hourly post error:', e.message) }
}

setInterval(sendHourlyPost, 60 * 60 * 1000)
console.log('⏰ Hourly posts scheduled every 60 minutes')

bot.on('message', async msg => {
  const chatId = msg.chat.id
  const state = pendingHourlyImage.get(chatId)
  if (!state || state.step !== 'caption') return
  if (!msg.text || msg.text.startsWith('/')) return
  pendingHourlyImage.delete(chatId)
  try {
    if (!fs.existsSync(HOURLY_IMAGES_DIR)) fs.mkdirSync(HOURLY_IMAGES_DIR)
    const imgPath = `${HOURLY_IMAGES_DIR}/${state.filename}`
    fs.writeFileSync(imgPath, state.buf)
    fs.writeFileSync(imgPath.replace('.jpg', '.txt'), msg.text)
    const count = fs.readdirSync(HOURLY_IMAGES_DIR).filter(f => f.endsWith('.jpg')).length
    bot.sendMessage(chatId, `✅ Image + caption saved!\n\nTotal images: <b>${count}</b>`, { parse_mode: 'HTML' })
    console.log(`🖼 Hourly image added: ${state.filename}`)
  } catch (e) { bot.sendMessage(chatId, `❌ Failed to save: ${e.message}`) }
})

bot.onText(/\/addimage(?:@\w+)?/, async msg => {
  pendingHourlyImage.set(msg.chat.id, { step: 'image' })
  const count = fs.existsSync(HOURLY_IMAGES_DIR)
    ? fs.readdirSync(HOURLY_IMAGES_DIR).filter(f => /\.(png|jpg|jpeg|gif|webp)$/i.test(f)).length : 0
  bot.sendMessage(msg.chat.id, `🖼 Send me an image to add to the hourly rotation.\n\nCurrent images: <b>${count}</b>`, { parse_mode: 'HTML' })
})

bot.onText(/\/images(?:@\w+)?/, msg => {
  const count = fs.existsSync(HOURLY_IMAGES_DIR)
    ? fs.readdirSync(HOURLY_IMAGES_DIR).filter(f => /\.(png|jpg|jpeg|gif|webp)$/i.test(f)).length : 0
  bot.sendMessage(msg.chat.id, `🖼 Hourly rotation has <b>${count}</b> image(s).\n\nUse /addimage to add more.`, { parse_mode: 'HTML' })
})

bot.onText(/\/price(?:@\w+)?/, async msg => {
  const keys = Object.keys(tracking)
  if (!keys.length) return bot.sendMessage(msg.chat.id, '⚠️ No tokens tracked. Use /track first.')
  for (const key of keys) {
    const { currency, issuer, name } = tracking[key]
    const data = await fetchTokenData(currency, issuer)
    if (!data) { bot.sendMessage(msg.chat.id, `⚠️ Could not fetch price for $${name}`); continue }
    const { bar, pct, targetFmt, mcapFmt } = buildMCBar(data.mcap)
    const change = data.priceChange > 0 ? `+${data.priceChange.toFixed(2)}%` : `${data.priceChange.toFixed(2)}%`
    bot.sendMessage(msg.chat.id,
`🪞 <b>$${name}</b>

💲 Price: <b>$${data.price.toFixed(8)}</b>
🏦 MCap: <b>${mcapFmt}</b>  ${change}
📊 Vol 24h: <b>${fmtNum(data.volume)}</b>

Next ${targetFmt}: ${bar} ${pct}%

<i>$REALITY is the truth. The complete meme. Now on XRPL. 🪞</i>`,
      { parse_mode: 'HTML' })
  }
})

bot.onText(/\/mc(?:@\w+)?/, async msg => {
  const keys = Object.keys(tracking)
  if (!keys.length) return bot.sendMessage(msg.chat.id, '⚠️ No tokens tracked. Use /track first.')
  for (const key of keys) {
    const { currency, issuer, name } = tracking[key]
    const data = await fetchTokenData(currency, issuer)
    if (!data) return bot.sendMessage(msg.chat.id, `⚠️ Could not fetch MC for $${name}`)
    const { bar, pct, targetFmt, mcapFmt } = buildMCBar(data.mcap)
    bot.sendMessage(msg.chat.id,
`🏦 <b>$${name} Market Cap</b>

💰 <b>${mcapFmt}</b>

Next target: <b>${targetFmt}</b>
${bar} ${pct}%

<i>$REALITY is the truth. 🪞</i>`,
      { parse_mode: 'HTML' })
  }
})

bot.onText(/\/chart(?:@\w+)?/, async msg => {
  const keys = Object.keys(tracking)
  if (!keys.length) return bot.sendMessage(msg.chat.id, '⚠️ No tokens tracked. Use /track first.')
  for (const key of keys) {
    const { currency, issuer, name } = tracking[key]
    const currencyHex = Buffer.from(currency.padEnd(20, '\0')).toString('hex').toUpperCase()
    const dexLink = `https://dexscreener.com/xrpl/${currencyHex}.${issuer}_xrp`.toLowerCase()
    const flLink  = `https://firstledger.net/token-v2/${issuer}/${currency}`
    bot.sendMessage(msg.chat.id,
`📊 <b>$${name} Charts</b>

<a href="${dexLink}">DexScreener Chart</a>
<a href="${flLink}">First Ledger</a>`,
      { parse_mode: 'HTML', disable_web_page_preview: true })
  }
})

bot.onText(/\/holders(?:@\w+)?/, async msg => {
  const keys = Object.keys(tracking)
  if (!keys.length) return bot.sendMessage(msg.chat.id, '⚠️ No tokens tracked. Use /track first.')
  for (const key of keys) {
    const { currency, issuer, name } = tracking[key]
    try {
      const r = await fetch(`https://api.xrpscan.com/api/v1/account/${issuer}/assets`)
      const d = await r.json()
      const asset = (d || []).find(a => a.currency === currency || a.currency?.includes(currency))
      const holders = asset?.holders || '—'
      bot.sendMessage(msg.chat.id,
`👥 <b>$${name} Holders</b>

<b>${holders}</b> holders

<i>$REALITY is the truth. 🪞</i>`,
        { parse_mode: 'HTML' })
    } catch { bot.sendMessage(msg.chat.id, `⚠️ Could not fetch holders for $${name}`) }
  }
})

bot.onText(/\/buy(?:@\w+)?/, async msg => {
  const keys = Object.keys(tracking)
  if (!keys.length) return bot.sendMessage(msg.chat.id, '⚠️ No tokens tracked. Use /track first.')
  for (const key of keys) {
    const { currency, issuer, name } = tracking[key]
    const flLink = `https://firstledger.net/token-v2/${issuer}/${currency}`
    bot.sendMessage(msg.chat.id,
`🟢 <b>How to Buy $${name}</b>

1️⃣ Get <a href="https://xumm.app">Xaman Wallet</a>
2️⃣ Fund with XRP
3️⃣ Set trustline for $${name}
4️⃣ <a href="${flLink}">Buy on First Ledger</a>

<i>$REALITY is the truth. The complete meme. Now on XRPL. 🪞</i>`,
      { parse_mode: 'HTML', disable_web_page_preview: true })
  }
})

bot.onText(/\/help(?:@\w+)?/, msg => {
  bot.sendMessage(msg.chat.id,
`🪞 <b>$REALITY Bot — Commands</b>

<b>Token Tracking</b>
/track <code>TICKER+rIssuer</code> — Track a token
/stop <code>TICKER+rIssuer</code> — Stop tracking
/stopall — Stop all tracking
/list — Show tracked tokens

<b>Token Info</b>
/price — Live price + MC
/mc — Market cap + bar
/chart — Chart links
/holders — Holder count
/buy — How to buy guide

<b>Bot Management</b>
/setimage — Change buy alert image
/addimage — Add image to hourly rotation
/images — Show image count
/test — Send test buy alert

<i>$REALITY is the truth. The complete meme. Now on XRPL. 🪞</i>`,
    { parse_mode: 'HTML' })
})

bot.setMyCommands([
  { command: 'track',    description: 'Track a token — TICKER+rIssuer' },
  { command: 'stop',     description: 'Stop tracking a token' },
  { command: 'stopall',  description: 'Stop all tracking' },
  { command: 'list',     description: 'Show tracked tokens' },
  { command: 'price',    description: 'Live price and market cap' },
  { command: 'mc',       description: 'Market cap progress bar' },
  { command: 'chart',    description: 'Chart links' },
  { command: 'holders',  description: 'Token holder count' },
  { command: 'buy',      description: 'How to buy guide' },
  { command: 'setimage', description: 'Change buy alert image' },
  { command: 'addimage', description: 'Add image to hourly rotation' },
  { command: 'images',   description: 'Show hourly image count' },
  { command: 'test',     description: 'Send test buy alert' },
  { command: 'help',     description: 'Show all commands' },
]).then(() => console.log('✅ Bot commands menu registered'))
  .catch(e => console.error('Commands menu error:', e.message))

console.log('🪞 $REALITY Buy Bot starting...')
connectXRPL().catch(console.error)