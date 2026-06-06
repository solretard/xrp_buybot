import xrpl from 'xrpl'
import TelegramBot from 'node-telegram-bot-api'
import fetch from 'node-fetch'
import fs from 'fs'

const BOT_TOKEN      = process.env.BOT_TOKEN         || '8716259652:AAFeu_Gl7urlPTiS_SUS4q6ZzRiN4zypZgs'
const CHAT_ID        = process.env.CHAT_ID           || '-1003968691129'
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY || ''
const TWITTER_BEARER = process.env.TWITTER_BEARER    || ''
const XRPL_WS        = 'wss://xrplcluster.com'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://socglufzpjtpyfhpbciv.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_KEY || ''

const IMAGE_PATH      = './alert.png'
const RAID_IMAGE_PATH = './raid.png'
const RAID_RESURFACE  = 5

const bot    = new TelegramBot(BOT_TOKEN, { polling: true })
let client   = null
let tracking = {}
let xrpUsd   = 0.5
let activeRaid = null

async function saveState() {
  if (!SUPABASE_KEY) return
  try {
    const state = {
      tracking,
      activeRaid: activeRaid && !activeRaid.ended ? activeRaid : null
    }
    await fetch(SUPABASE_URL + '/rest/v1/bot_state', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify([
        { key: 'tracking', value: state.tracking, updated_at: new Date().toISOString() },
        { key: 'activeRaid', value: state.activeRaid, updated_at: new Date().toISOString() }
      ])
    })
    console.log('💾 State saved to Supabase')
  } catch (e) { console.error('saveState error:', e.message) }
}

async function loadState() {
  if (!SUPABASE_KEY) return
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/bot_state?select=key,value', {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY
      }
    })
    const rows = await r.json()
    for (const row of rows) {
      if (row.key === 'tracking' && row.value) {
        tracking = row.value
        console.log('📂 Restored tracking:', Object.keys(tracking).join(', ') || 'none')
      }
      if (row.key === 'activeRaid' && row.value) {
        activeRaid = row.value
        console.log('📂 Restored active raid:', activeRaid.url)
      }
    }
  } catch (e) { console.error('loadState error:', e.message) }
}

async function isAdmin(chatId, userId) {
  try {
    const admins = await bot.getChatAdministrators(chatId)
    return admins.some(a => a.user.id === userId)
  } catch { return false }
}
async function requireAdmin(msg, fn) {
  const ok = await isAdmin(msg.chat.id, msg.from.id)
  if (!ok) { bot.sendMessage(msg.chat.id, '🔒 Admins only.'); return }
  await fn()
}

async function fetchXrpPrice() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd')
    const d = await r.json()
    xrpUsd = d?.ripple?.usd || xrpUsd
    console.log('💰 XRP: $' + xrpUsd)
  } catch {}
}
fetchXrpPrice()
setInterval(fetchXrpPrice, 60000)

async function fetchTokenData(currency, issuer) {
  try {
    const tickers = [currency]
    if (!currency.startsWith('$')) tickers.push('$' + currency)
    else tickers.push(currency.slice(1))
    for (const ticker of tickers) {
      const hex = Buffer.from(ticker.padEnd(20, '\0')).toString('hex').toUpperCase()
      const url = 'https://api.dexscreener.com/latest/dex/pairs/xrpl/' + hex + '.' + issuer + '_xrp'
      const r = await fetch(url.toLowerCase())
      const d = await r.json()
      const pair = d?.pair || d?.pairs?.[0] || null
      if (pair) return {
        mcap: pair.marketCap || pair.fdv || 0,
        price: parseFloat(pair.priceUsd || 0),
        volume: pair.volume?.h24 || 0,
        priceChange: pair.priceChange?.h24 || 0,
      }
    }
    return null
  } catch (e) { console.log('DexScreener error: ' + e.message); return null }
}

function buildMCBar(mcap) {
  const MS = [10000,25000,50000,100000,250000,500000,1000000,5000000,10000000,50000000,100000000,500000000,1000000000]
  let target = MS[MS.length-1], prev = 0
  for (const m of MS) { if (mcap < m) { target = m; break } prev = m }
  const pct = Math.round(Math.min((mcap-prev)/(target-prev),1)*100)
  const filled = Math.round(pct/10)
  const bar = '🪞'.repeat(filled) + '⬜'.repeat(10-filled)
  const fmt = n => n>=1e6 ? '$'+(n/1e6).toFixed(1)+'M' : n>=1000 ? '$'+(n/1000).toFixed(0)+'K' : '$'+n.toFixed(0)
  return { bar, pct, targetFmt: fmt(target), mcapFmt: fmt(mcap) }
}
function fmtNum(n) {
  if (!n) return '$0'
  if (n>=1e6) return '$'+(n/1e6).toFixed(2)+'M'
  if (n>=1000) return '$'+(n/1000).toFixed(1)+'K'
  return '$'+n.toFixed(2)
}
function hexToTicker(hex) {
  try {
    const clean = hex.replace(/00+$/, '')
    const decoded = Buffer.from(clean, 'hex').toString('ascii').replace(/[^a-zA-Z0-9$]/g, '')
    return decoded.toUpperCase()
  } catch { return hex }
}

function extractTweetId(url) {
  const m = url.match(/status\/(\d+)/)
  return m ? m[1] : null
}

async function fetchTweetMetrics(tweetId) {
  if (!TWITTER_BEARER) { console.log('⚠️ No TWITTER_BEARER set'); return null }
  try {
    const url = 'https://api.twitter.com/2/tweets/' + tweetId + '?tweet.fields=public_metrics'
    console.log('🐦 Fetching tweet:', url)
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + TWITTER_BEARER } })
    const d = await r.json()
    console.log('🐦 Twitter response:', JSON.stringify(d))
    const m = d?.data?.public_metrics
    if (!m) return null
    return { likes: m.like_count||0, retweets: m.retweet_count||0, comments: m.reply_count||0 }
  } catch (e) { console.log('Twitter error: ' + e.message); return null }
}

function progressBar(done, target) {
  const size = 8
  const filled = Math.round(Math.min(done/target,1)*size)
  return '🟩'.repeat(filled) + '⬜'.repeat(size-filled)
}

function buildRaidMsg(raid, metrics) {
  const likes    = metrics?.likes    ?? 0
  const retweets = metrics?.retweets ?? 0
  const comments = metrics?.comments ?? 0
  const lDone = Math.min(likes,    raid.targetLikes)
  const rDone = Math.min(retweets, raid.targetRetweets)
  const cDone = Math.min(comments, raid.targetComments)
  const lLeft = Math.max(raid.targetLikes    - likes,    0)
  const rLeft = Math.max(raid.targetRetweets - retweets, 0)
  const cLeft = Math.max(raid.targetComments - comments, 0)
  const lPct = Math.round(Math.min(lDone/raid.targetLikes,1)*100)
  const rPct = Math.round(Math.min(rDone/raid.targetRetweets,1)*100)
  const cPct = Math.round(Math.min(cDone/raid.targetComments,1)*100)

  return '🚨 <b>RAID — $REALITY</b> 🪞\n\n' +
    '🎯 <b>Target:</b> ' + raid.url + '\n\n' +
    '❤️ <b>Likes</b>\n' + progressBar(lDone,raid.targetLikes) + ' ' + lDone + '/' + raid.targetLikes + ' (' + lPct + '%) — <b>' + lLeft + ' left</b>\n\n' +
    '🔁 <b>Retweets</b>\n' + progressBar(rDone,raid.targetRetweets) + ' ' + rDone + '/' + raid.targetRetweets + ' (' + rPct + '%) — <b>' + rLeft + ' left</b>\n\n' +
    '💬 <b>Comments</b>\n' + progressBar(cDone,raid.targetComments) + ' ' + cDone + '/' + raid.targetComments + ' (' + cPct + '%) — <b>' + cLeft + ' left</b>\n\n' +
    'Two faces. One truth. One community.\nW.E. Hill, 1921 → XRPL, 2025.\n\n' +
    '<b>Let\'s go $REALITY fam 🪞🪞🪞</b>'
}

async function postRaidMessage(raid) {
  const metrics = await fetchTweetMetrics(raid.tweetId)
  const text = buildRaidMsg(raid, metrics)
  try {
    if (raid.msgId) {
      try { await bot.deleteMessage(raid.chatId, raid.msgId) } catch {}
    }
    const raidOpts = {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[
        { text: '🐦 Open Tweet', url: raid.url },
        { text: '❌ End Raid', callback_data: 'endraid' }
      ]]}
    }
    const sent = fs.existsSync(RAID_IMAGE_PATH)
      ? await bot.sendPhoto(raid.chatId, RAID_IMAGE_PATH, { ...raidOpts, caption: text })
      : await bot.sendMessage(raid.chatId, text, { ...raidOpts, disable_web_page_preview: true })
    raid.msgId = sent.message_id
    raid.msgCounter = 0
    if (metrics) {
      const allDone = metrics.likes >= raid.targetLikes &&
                      metrics.retweets >= raid.targetRetweets &&
                      metrics.comments >= raid.targetComments
      if (allDone) await endRaid(raid, '✅ All targets hit! Raid complete 🪞')
    }
  } catch (e) { console.error('Raid post error:', e.message) }
}

async function endRaid(raid, reason) {
  if (!raid || raid.ended) return
  raid.ended = true
  const metrics = await fetchTweetMetrics(raid.tweetId)
  const likes    = metrics?.likes    ?? '?'
  const retweets = metrics?.retweets ?? '?'
  const comments = metrics?.comments ?? '?'
  try {
    if (raid.msgId) { try { await bot.deleteMessage(raid.chatId, raid.msgId) } catch {} }
    await bot.sendMessage(raid.chatId,
      reason + '\n\n<b>Final stats:</b>\n' +
      '❤️ Likes: <b>' + likes + '</b> / ' + raid.targetLikes + '\n' +
      '🔁 Retweets: <b>' + retweets + '</b> / ' + raid.targetRetweets + '\n' +
      '💬 Comments: <b>' + comments + '</b> / ' + raid.targetComments + '\n\n' +
      '<i>$REALITY fam showing up 🪞</i>',
      { parse_mode: 'HTML' })
  } catch {}
  activeRaid = null
  await saveState()
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
  client.on('transaction', async tx => {
    try { await handleTx(tx) } catch (e) { console.error('TX error:', e.message) }
  })
}
async function subscribeToken(issuer) {
  await connectXRPL()
  await client.request({ command: 'subscribe', accounts: [issuer] })
}
async function unsubscribeToken(issuer) {
  if (!client?.isConnected()) return
  try { await client.request({ command: 'unsubscribe', accounts: [issuer] }) } catch {}
}

async function handleTx(tx) {
  const t = tx.transaction || tx
  const meta = tx.meta || t.meta
  if (!meta || meta.TransactionResult !== 'tesSUCCESS') return
  const txType = t.TransactionType
  console.log('📥 TX: ' + txType + ' from ' + t.Account)
  if (!['Payment','OfferCreate','AMMSwap'].includes(txType)) return
  const nodes = meta.AffectedNodes || []
  const buyer = t.Account
  for (const key of Object.keys(tracking)) {
    const { currency, issuer, name } = tracking[key]
    const hex  = Buffer.from(currency.padEnd(20,'\0')).toString('hex').toUpperCase()
    const hex2 = Buffer.from(('$'+currency).padEnd(20,'\0')).toString('hex').toUpperCase()
    let xrpSpent = 0, tokensReceived = 0, isNewHolder = false
    for (const node of nodes) {
      const isCreated = !!node.CreatedNode
      const entry = node.ModifiedNode || node.CreatedNode || node.DeletedNode
      if (!entry) continue
      const ltype = entry.LedgerEntryType
      const final = entry.FinalFields || entry.NewFields || {}
      const prev  = entry.PreviousFields || {}
      if (ltype === 'AccountRoot' && final.Account === buyer) {
        const pb = parseInt(prev.Balance||'0'), fb = parseInt(final.Balance||'0')
        if (pb>0 && fb>0 && pb>fb) xrpSpent = (pb-fb)/1e6
      }
      if (ltype === 'RippleState') {
        const bc = final.Balance?.currency||''
        if (!(bc===currency||bc===hex||bc===hex2||hexToTicker(bc)===currency||hexToTicker(bc)==='$'+currency)) continue
        const pv = parseFloat(prev.Balance?.value??'0'), fv = parseFloat(final.Balance?.value??'0')
        const diff = fv-pv
        const la = final.LowLimit?.issuer||'', ha = final.HighLimit?.issuer||''
        if (!(la===buyer||ha===buyer)) continue
        if (isCreated) { tokensReceived=Math.abs(fv); isNewHolder=true }
        else if (diff>0&&pv>=0) tokensReceived=diff
        else if (diff<0&&pv<=0) tokensReceived=Math.abs(diff)
        else if (Math.abs(diff)>0) tokensReceived=Math.abs(diff)
      }
    }
    if (tokensReceived>0 && xrpSpent>0.0001) {
      console.log('🚨 BUY: ' + xrpSpent.toFixed(4) + ' XRP → ' + tokensReceived.toFixed(2) + ' ' + name)
      await sendBuyAlert({ name, currency, issuer, buyerAddr: buyer, xrpSpent, tokensReceived, txHash: t.hash, isNewHolder })
    }
  }
}

async function sendBuyAlert({ name, currency, issuer, buyerAddr, xrpSpent, tokensReceived, txHash, isNewHolder=false }) {
  const usdVal  = (xrpSpent*xrpUsd).toFixed(2)
  const short   = buyerAddr.slice(0,6)+'...'+buyerAddr.slice(-4)
  const txLink  = 'https://xrpscan.com/tx/'+txHash
  const buyLink = 'https://xrpscan.com/account/'+buyerAddr
  const flLink  = 'https://firstledger.net/token-v2/'+issuer+'/'+currency
  const dexLink = 'https://dexscreener.com/xrpl/'+currency+'.'+issuer+'_xrp'
  const size    = xrpSpent<10 ? '🐟' : xrpSpent<100 ? '🐬' : '🐳'
  const newBadge = isNewHolder ? '\n🆕 <b>New Holder!</b>' : ''
  const td = await fetchTokenData(currency, issuer)
  let mcLine='', barLine='', volLine=''
  if (td && td.mcap>0) {
    const { bar, pct, targetFmt, mcapFmt } = buildMCBar(td.mcap)
    const change = td.priceChange>0 ? '+'+td.priceChange.toFixed(1)+'%' : td.priceChange.toFixed(1)+'%'
    mcLine  = '\n🏦 <b>MCap:</b> '+mcapFmt+'  |  <b>'+change+'</b>'
    volLine = '📊 <b>Vol 24h:</b> '+fmtNum(td.volume)
    barLine = '\nNext '+targetFmt+': '+bar+' '+pct+'%'
  }
  const msg = '🪞 <b>New BUY — $'+name+'</b>  '+size+'\n\n' +
    '💙 <b>'+xrpSpent.toFixed(2)+' XRP</b>  |  <b>$'+usdVal+'</b>\n' +
    '📈 <b>'+tokensReceived.toLocaleString(undefined,{maximumFractionDigits:0})+' $'+name+'</b>\n' +
    '👤 <a href="'+buyLink+'">'+short+'</a>  |  <a href="'+txLink+'">TX ↗</a>'+newBadge+mcLine+'\n' +
    volLine+barLine+'\n\n' +
    '<a href="'+flLink+'">First Ledger</a>  |  <a href="'+dexLink+'">Chart</a>\n\n' +
    '<i>$REALITY is the truth. The complete meme. Now on XRPL. 🪞</i>'
  try {
    const opts = { caption: msg, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[
      { text: '📊 Chart', url: dexLink },
      { text: '🟢 Buy Now', url: flLink },
      { text: '🔍 TX', url: txLink },
    ]]}}
    if (fs.existsSync(IMAGE_PATH)) await bot.sendPhoto(CHAT_ID, IMAGE_PATH, opts)
    else await bot.sendMessage(CHAT_ID, msg, { parse_mode: 'HTML', disable_web_page_preview: true })
    console.log('✅ Alert sent')
  } catch (e) { console.error('Send error:', e.message) }
}

function parseCA(input) {
  const parts = input.trim().split(/[\s+]+/)
  if (parts.length>=2 && parts[1].startsWith('r') && parts[1].length>=25)
    return { currency: parts[0].toUpperCase(), issuer: parts[1] }
  return null
}

const REALITY_SYSTEM_PROMPT = `You are the $REALITY bot for the $REALITY meme coin on XRPL.
$REALITY is built around the W.E. Hill 1921 optical illusion cartoon — the original meme ever drawn.
$LUCAS = how you think you look. $LUTHER = how you really look. $REALITY = the complete truth — both faces, one token.
Tagline: "The punchline nobody launched". Launched on XRPL in 2025.
Personality: witty, sharp, self-aware, confident, uses mirror metaphors, never hypes or shills.
Keep replies 2-4 sentences max. Use 🪞 occasionally.
Only respond when someone clearly asks about $REALITY, the narrative, or the meme. Otherwise reply with exactly: null`

const cooldowns = new Map()
async function claudeRespond(text, username) {
  if (!ANTHROPIC_KEY) return null
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', max_tokens: 300,
        system: REALITY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: (username||'') + ': ' + text }]
      })
    })
    const d = await r.json()
    const t = d?.content?.[0]?.text?.trim()
    return (!t || t.toLowerCase()==='null') ? null : t
  } catch (e) { console.error('Claude error:', e.message); return null }
}

const TRIGGERS = ['reality','$reality','lucas','$lucas','luther','$luther','xrpl','meme coin','memecoin','w.e. hill','1921','narrative','what is','wen moon','when moon','explain','tell me']

bot.onText(/\/start(?:@\w+)?/, msg => {
  bot.sendMessage(msg.chat.id,
    '🪞 <b>$REALITY Bot</b>\n\n' +
    '/raid <code>url likes comments retweets</code> — Start raid\n' +
    '/endraid — End active raid\n' +
    '/track <code>rIssuerAddress</code> — Track token\n' +
    '/price — Live price\n/mc — Market cap\n/chart — Charts\n/holders — Holders\n/buy — How to buy\n/help — All commands\n\n' +
    '<i>W.E.H 1921 · XRPL</i>', { parse_mode: 'HTML' })
})

async function resolveTokenFromIssuer(issuer) {
  // Retry XRPScan obligations up to 3 times with 2s delay before giving up
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch('https://api.xrpscan.com/api/v1/account/'+issuer+'/obligations')
      const d = await r.json()
      console.log('🔍 XRPScan obligations (attempt '+attempt+'):', JSON.stringify(d).slice(0, 200))
      if (Array.isArray(d) && d.length > 0) {
        const cur = d[0].currency
        if (cur) {
          const ticker = (cur.length > 6) ? hexToTicker(cur) : cur
          if (ticker && ticker.length > 0) return ticker
        }
      }
    } catch (e) { console.log('resolveToken attempt '+attempt+' error: '+e.message) }
    if (attempt < 3) await new Promise(r => setTimeout(r, 2000))
  }
  return null
}

bot.onText(/\/track(?:@\w+)?\s+(\S+)/, async (msg, match) => {
  await requireAdmin(msg, async () => {
    const input = match[1].trim()
    let issuer, currency

    // If it's just an issuer address (starts with r, length 25+)
    if (input.startsWith('r') && input.length >= 25 && !input.includes('+') && !input.includes(' ')) {
      issuer = input
      bot.sendMessage(msg.chat.id, '🔍 Looking up token for <code>'+issuer+'</code>...', { parse_mode: 'HTML' })
      currency = await resolveTokenFromIssuer(issuer)
      if (!currency) return bot.sendMessage(msg.chat.id, '❌ Could not detect token. Try: /track TICKER+rIssuerAddress')
    } else {
      // Legacy format: TICKER+issuer or TICKER issuer
      const parts = input.split(/[\s+]+/)
      if (parts.length < 2 || !parts[1].startsWith('r') || parts[1].length < 25)
        return bot.sendMessage(msg.chat.id, '❌ Format: /track rIssuerAddress\nOr: /track TICKER+rIssuerAddress')
      currency = parts[0].toUpperCase()
      issuer = parts[1]
    }

    const key = currency+'_'+issuer
    if (tracking[key]) return bot.sendMessage(msg.chat.id, '⚠️ Already tracking <b>$'+currency+'</b>', { parse_mode: 'HTML' })
    try {
      await subscribeToken(issuer)
      tracking[key] = { currency, issuer, name: currency, startTime: Date.now() }
      await saveState()
      bot.sendMessage(msg.chat.id, '✅ Tracking <b>$'+currency+'</b>\n\n<code>'+issuer+'</code>\n\nBuy alerts incoming 🪞', { parse_mode: 'HTML' })
    } catch (e) { bot.sendMessage(msg.chat.id, '❌ '+e.message) }
  })
})

bot.onText(/\/stop(?:@\w+)?\s+(.+)/, async (msg, match) => {
  await requireAdmin(msg, async () => {
    const p = parseCA(match[1])
    if (!p) return bot.sendMessage(msg.chat.id, '❌ Format: /stop TICKER+rIssuerAddress')
    const key = p.currency+'_'+p.issuer
    if (!tracking[key]) return bot.sendMessage(msg.chat.id, '⚠️ Not tracking', { parse_mode: 'HTML' })
    await unsubscribeToken(p.issuer)
    delete tracking[key]
    await saveState()
    bot.sendMessage(msg.chat.id, '🛑 Stopped <b>$'+p.currency+'</b>', { parse_mode: 'HTML' })
  })
})

bot.onText(/\/stopall(?:@\w+)?/, async msg => {
  await requireAdmin(msg, async () => {
    const count = Object.keys(tracking).length
    if (!count) return bot.sendMessage(msg.chat.id, '⚠️ Nothing tracked.')
    for (const key of Object.keys(tracking)) {
      try { await unsubscribeToken(tracking[key].issuer) } catch {}
      delete tracking[key]
    }
    await saveState()
    bot.sendMessage(msg.chat.id, '🛑 Stopped all '+count+' token(s).')
  })
})

bot.onText(/\/list(?:@\w+)?/, async msg => {
  await requireAdmin(msg, async () => {
    const keys = Object.keys(tracking)
    if (!keys.length) return bot.sendMessage(msg.chat.id, '📋 Nothing tracked.')
    const list = keys.map(k => {
      const { currency, issuer, startTime } = tracking[k]
      return '🔵 <b>$'+currency+'</b> — '+Math.floor((Date.now()-startTime)/60000)+'m\n<code>'+issuer+'</code>'
    }).join('\n\n')
    bot.sendMessage(msg.chat.id, '📋 <b>Tracked:</b>\n\n'+list, { parse_mode: 'HTML' })
  })
})

bot.onText(/\/test(?:@\w+)?/, async msg => {
  await requireAdmin(msg, async () => {
    await sendBuyAlert({ name:'REALITY', currency:'REALITY', issuer:'rTestIssuerXRPL1234567890ABCD', buyerAddr:'rTestBuyerXRPL1234567890ABCD', xrpSpent:25.5, tokensReceived:4958770, txHash:'FAKEHASH1234567890', isNewHolder:true })
    bot.sendMessage(msg.chat.id, '🧪 Test alert sent!')
  })
})

bot.onText(/\/raid(?:@\w+)?\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)/, async (msg, match) => {
  await requireAdmin(msg, async () => {
    if (activeRaid && !activeRaid.ended)
      return bot.sendMessage(msg.chat.id, '⚠️ Raid already active. Use /endraid first.')
    const url = match[1]
    const tweetId = extractTweetId(url)
    if (!tweetId) return bot.sendMessage(msg.chat.id, '❌ Could not extract tweet ID from URL.')
    activeRaid = {
      chatId: msg.chat.id, url, tweetId,
      targetLikes: parseInt(match[2]),
      targetComments: parseInt(match[3]),
      targetRetweets: parseInt(match[4]),
      msgId: null, msgCounter: 0, startTime: Date.now(), ended: false
    }
    await saveState()
    await postRaidMessage(activeRaid)
  })
})

bot.onText(/\/raid(?:@\w+)?$/, async msg => {
  await requireAdmin(msg, async () => {
    bot.sendMessage(msg.chat.id,
      '🚨 <b>Raid Usage:</b>\n\n<code>/raid [url] [likes] [comments] [retweets]</code>\n\nExample:\n<code>/raid https://x.com/RealityXRPL/status/123 20 20 20</code>',
      { parse_mode: 'HTML' })
  })
})

bot.onText(/\/endraid(?:@\w+)?/, async msg => {
  await requireAdmin(msg, async () => {
    if (!activeRaid || activeRaid.ended) return bot.sendMessage(msg.chat.id, '⚠️ No active raid.')
    await endRaid(activeRaid, '🛑 Raid ended by admin.')
  })
})

bot.on('callback_query', async query => {
  if (query.data === 'endraid') {
    const ok = await isAdmin(query.message.chat.id, query.from.id)
    if (!ok) return bot.answerCallbackQuery(query.id, { text: '🔒 Admins only.' })
    if (!activeRaid || activeRaid.ended) return bot.answerCallbackQuery(query.id, { text: 'No active raid.' })
    await endRaid(activeRaid, '🛑 Raid ended by admin.')
    bot.answerCallbackQuery(query.id, { text: 'Raid ended.' })
  }
})

bot.onText(/\/price(?:@\w+)?/, async msg => {
  const keys = Object.keys(tracking)
  if (!keys.length) return bot.sendMessage(msg.chat.id, '⚠️ No tokens tracked.')
  for (const key of keys) {
    const { currency, issuer, name } = tracking[key]
    const d = await fetchTokenData(currency, issuer)
    if (!d) { bot.sendMessage(msg.chat.id, '⚠️ Could not fetch price for $'+name); continue }
    const { bar, pct, targetFmt, mcapFmt } = buildMCBar(d.mcap)
    const change = d.priceChange>0 ? '+'+d.priceChange.toFixed(2)+'%' : d.priceChange.toFixed(2)+'%'
    bot.sendMessage(msg.chat.id,
      '🪞 <b>$'+name+'</b>\n\n💲 Price: <b>$'+d.price.toFixed(8)+'</b>\n🏦 MCap: <b>'+mcapFmt+'</b>  '+change+'\n📊 Vol 24h: <b>'+fmtNum(d.volume)+'</b>\n\nNext '+targetFmt+': '+bar+' '+pct+'%\n\n<i>$REALITY is the truth. 🪞</i>',
      { parse_mode: 'HTML' })
  }
})

bot.onText(/\/mc(?:@\w+)?/, async msg => {
  const keys = Object.keys(tracking)
  if (!keys.length) return bot.sendMessage(msg.chat.id, '⚠️ No tokens tracked.')
  for (const key of keys) {
    const { currency, issuer, name } = tracking[key]
    const d = await fetchTokenData(currency, issuer)
    if (!d) return bot.sendMessage(msg.chat.id, '⚠️ Could not fetch MC')
    const { bar, pct, targetFmt, mcapFmt } = buildMCBar(d.mcap)
    bot.sendMessage(msg.chat.id,
      '🏦 <b>$'+name+' Market Cap</b>\n\n💰 <b>'+mcapFmt+'</b>\n\nNext target: <b>'+targetFmt+'</b>\n'+bar+' '+pct+'%\n\n<i>$REALITY is the truth. 🪞</i>',
      { parse_mode: 'HTML' })
  }
})

bot.onText(/\/chart(?:@\w+)?/, async msg => {
  const keys = Object.keys(tracking)
  if (!keys.length) return bot.sendMessage(msg.chat.id, '⚠️ No tokens tracked.')
  for (const key of keys) {
    const { currency, issuer, name } = tracking[key]
    const hex = Buffer.from(currency.padEnd(20,'\0')).toString('hex').toUpperCase()
    const dexLink = ('https://dexscreener.com/xrpl/'+hex+'.'+issuer+'_xrp').toLowerCase()
    const flLink  = 'https://firstledger.net/token-v2/'+issuer+'/'+currency
    bot.sendMessage(msg.chat.id,
      '📊 <b>$'+name+' Charts</b>\n\n<a href="'+dexLink+'">DexScreener</a>  |  <a href="'+flLink+'">First Ledger</a>',
      { parse_mode: 'HTML', disable_web_page_preview: true })
  }
})

bot.onText(/\/holders(?:@\w+)?/, async msg => {
  const keys = Object.keys(tracking)
  if (!keys.length) return bot.sendMessage(msg.chat.id, '⚠️ No tokens tracked.')
  for (const key of keys) {
    const { currency, issuer, name } = tracking[key]
    try {
      const r = await fetch('https://api.xrpscan.com/api/v1/account/'+issuer+'/assets')
      const d = await r.json()
      const asset = (d||[]).find(a => a.currency===currency || a.currency?.includes(currency))
      bot.sendMessage(msg.chat.id,
        '👥 <b>$'+name+' Holders</b>\n\n<b>'+(asset?.holders||'—')+'</b> holders\n\n<i>$REALITY is the truth. 🪞</i>',
        { parse_mode: 'HTML' })
    } catch { bot.sendMessage(msg.chat.id, '⚠️ Could not fetch holders') }
  }
})

bot.onText(/\/buy(?:@\w+)?/, async msg => {
  const keys = Object.keys(tracking)
  if (!keys.length) return bot.sendMessage(msg.chat.id, '⚠️ No tokens tracked.')
  for (const key of keys) {
    const { currency, issuer, name } = tracking[key]
    const flLink = 'https://firstledger.net/token-v2/'+issuer+'/'+currency
    bot.sendMessage(msg.chat.id,
      '🟢 <b>How to Buy $'+name+'</b>\n\n1️⃣ Get <a href="https://xumm.app">Xaman Wallet</a>\n2️⃣ Fund with XRP\n3️⃣ Set trustline for $'+name+'\n4️⃣ <a href="'+flLink+'">Buy on First Ledger</a>\n\n<i>$REALITY is the truth. 🪞</i>',
      { parse_mode: 'HTML', disable_web_page_preview: true })
  }
})

bot.onText(/\/help(?:@\w+)?/, msg => {
  bot.sendMessage(msg.chat.id,
    '🪞 <b>$REALITY Bot</b>\n\n' +
    '<b>Raids (admins)</b>\n/raid <code>url likes comments retweets</code>\n/endraid — End active raid\n\n' +
    '<b>Tracking (admins)</b>\n/track <code>TICKER+rIssuer</code>\n/stop <code>TICKER+rIssuer</code>\n/stopall\n/list\n\n' +
    '<b>Info (public)</b>\n/price /mc /chart /holders /buy\n\n' +
    '<b>Admin tools</b>\n/setimage /addimage /images /test\n\n' +
    '<i>$REALITY is the truth. 🪞</i>',
    { parse_mode: 'HTML' })
})

const pendingImageUpload = new Set()
const pendingRaidImageUpload = new Set()
const pendingHourlyImage = new Map()
if (!fs.existsSync('./images')) fs.mkdirSync('./images')

bot.onText(/\/setimage(?:@\w+)?/, async msg => {
  await requireAdmin(msg, async () => { pendingImageUpload.add(msg.chat.id); bot.sendMessage(msg.chat.id, '🖼 Send the new alert image.') })
})
bot.onText(/\/setraidimage(?:@\w+)?/, async msg => {
  await requireAdmin(msg, async () => { pendingRaidImageUpload.add(msg.chat.id); bot.sendMessage(msg.chat.id, '🚨 Send the new raid image.') })
})
bot.onText(/\/addimage(?:@\w+)?/, async msg => {
  await requireAdmin(msg, async () => {
    pendingHourlyImage.set(msg.chat.id, { step: 'image' })
    const count = fs.existsSync('./images') ? fs.readdirSync('./images').filter(f=>/\.(png|jpg|jpeg|gif|webp)$/i.test(f)).length : 0
    bot.sendMessage(msg.chat.id, '🖼 Send image. Current: <b>'+count+'</b>', { parse_mode: 'HTML' })
  })
})
bot.onText(/\/images(?:@\w+)?/, async msg => {
  await requireAdmin(msg, async () => {
    const count = fs.existsSync('./images') ? fs.readdirSync('./images').filter(f=>/\.(png|jpg|jpeg|gif|webp)$/i.test(f)).length : 0
    bot.sendMessage(msg.chat.id, '🖼 <b>'+count+'</b> image(s) in rotation.', { parse_mode: 'HTML' })
  })
})

bot.on('message', async msg => {
  const chatId = msg.chat.id
  const text = msg.text || ''

  const hs = pendingHourlyImage.get(chatId)
  if (hs?.step==='caption' && text && !text.startsWith('/')) {
    pendingHourlyImage.delete(chatId)
    try {
      if (!fs.existsSync('./images')) fs.mkdirSync('./images')
      const p = './images/'+hs.filename
      fs.writeFileSync(p, hs.buf)
      fs.writeFileSync(p.replace(/\.(jpg|jpeg|png|gif|webp)$/i,'.txt'), text)
      const count = fs.readdirSync('./images').filter(f=>/\.(png|jpg|jpeg|gif|webp)$/i.test(f)).length
      bot.sendMessage(chatId, '✅ Saved! Total: <b>'+count+'</b>', { parse_mode: 'HTML' })
    } catch (e) { bot.sendMessage(chatId, '❌ '+e.message) }
    return
  }

  if (activeRaid && !activeRaid.ended && chatId.toString()===activeRaid.chatId.toString() && !text.startsWith('/')) {
    // Only count real human messages, ignore bot messages
    if (!msg.from.is_bot) {
      activeRaid.msgCounter++
      if (activeRaid.msgCounter >= RAID_RESURFACE) {
        await postRaidMessage(activeRaid)
      }
    }
  }

  if (!text || text.startsWith('/') || msg.chat.type==='private') return
  const low = text.toLowerCase()
  if (!TRIGGERS.some(kw => low.includes(kw))) return
  const ck = chatId+'_'+msg.from.id
  const last = cooldowns.get(ck)
  if (last && Date.now()-last < 60000) return
  cooldowns.set(ck, Date.now())
  const reply = await claudeRespond(text, msg.from.username||msg.from.first_name||'')
  if (!reply) return
  bot.sendMessage(chatId, reply, { parse_mode: 'HTML', reply_to_message_id: msg.message_id })
})

bot.on('photo', async msg => {
  const chatId = msg.chat.id
  const getFile = async () => {
    const fid = msg.photo[msg.photo.length-1].file_id
    const url = await bot.getFileLink(fid)
    const res = await fetch(url)
    return Buffer.from(await res.arrayBuffer())
  }
  if (pendingImageUpload.has(chatId)) {
    pendingImageUpload.delete(chatId)
    try { fs.writeFileSync(IMAGE_PATH, await getFile()); bot.sendMessage(chatId, '✅ Alert image updated!') }
    catch (e) { bot.sendMessage(chatId, '❌ '+e.message) }
    return
  }
  if (pendingRaidImageUpload.has(chatId)) {
    pendingRaidImageUpload.delete(chatId)
    try { fs.writeFileSync(RAID_IMAGE_PATH, await getFile()); bot.sendMessage(chatId, '✅ Raid image updated!') }
    catch (e) { bot.sendMessage(chatId, '❌ '+e.message) }
    return
  }
  if (pendingHourlyImage.has(chatId) && pendingHourlyImage.get(chatId).step==='image') {
    try {
      const buf = await getFile()
      pendingHourlyImage.set(chatId, { step:'caption', buf, filename:'img_'+Date.now()+'.jpg' })
      bot.sendMessage(chatId, '✏️ Now send the caption.')
    } catch (e) { pendingHourlyImage.delete(chatId); bot.sendMessage(chatId, '❌ '+e.message) }
  }
})

bot.on('new_chat_members', async msg => {
  for (const m of (msg.new_chat_members||[])) {
    if (m.is_bot) continue
    const name = m.first_name||m.username||'anon'
    const welcome = '🪞 Welcome, <b>'+name+'</b>!\n\nYou just stepped into $REALITY.\n\nNot an illusion. Not a hype play.\nThe complete meme — both faces, one truth.\n\nW.E. Hill drew it in 1921.\nWe brought it to XRPL in 2025.\n\n<i>$REALITY is the truth. 🪞</i>'
    try {
      if (fs.existsSync(IMAGE_PATH)) await bot.sendPhoto(msg.chat.id, IMAGE_PATH, { caption: welcome, parse_mode: 'HTML' })
      else await bot.sendMessage(msg.chat.id, welcome, { parse_mode: 'HTML' })
    } catch (e) { console.error('Welcome error:', e.message) }
  }
})

const HOURLY = [
  '🪞 Two faces. One truth. $REALITY on XRPL.',
  '🪞 The first meme in history is now a coin. W.E. Hill, 1921. $REALITY.',
  '💙 How you think your portfolio looks vs how it really looks. $REALITY knows.',
  '🪞 1921 → 2025. The original duality. Now on the fastest ledger.',
  '💙 Not a meme. A mirror. $REALITY.',
  '📊 Charts go up. Charts go down. $REALITY stays real. Always.',
  '🪞 The complete meme is live. Both faces. One token. XRPL.',
  '💙 While others chase illusions, $REALITY holders know the truth.',
  '🪞 First meme ever drawn. First CTO narrative on XRPL. $REALITY.',
  '💙 You can\'t escape reality. You might as well hold it. $REALITY on XRPL.',
]
let lastImg = -1
async function sendHourlyPost() {
  try {
    let imgPath = IMAGE_PATH, caption = null
    if (fs.existsSync('./images')) {
      const imgs = fs.readdirSync('./images').filter(f=>/\.(jpg|jpeg|png|gif|webp)$/i.test(f))
      if (imgs.length>0) {
        let idx; do { idx=Math.floor(Math.random()*imgs.length) } while (idx===lastImg && imgs.length>1)
        lastImg=idx; imgPath='./images/'+imgs[idx]
        const cf = imgPath.replace(/\.(jpg|jpeg|png|gif|webp)$/i,'.txt')
        if (fs.existsSync(cf)) caption=fs.readFileSync(cf,'utf8').trim()
      }
    }
    const msg = caption || HOURLY[Math.floor(Math.random()*HOURLY.length)]
    if (fs.existsSync(imgPath)) await bot.sendPhoto(CHAT_ID, imgPath, { caption: msg, parse_mode: 'HTML' })
    else await bot.sendMessage(CHAT_ID, msg, { parse_mode: 'HTML' })
    console.log('⏰ Hourly post sent')
  } catch (e) { console.error('Hourly error:', e.message) }
}
setInterval(sendHourlyPost, 60*60*1000)

bot.setMyCommands([
  { command:'track',    description:'Track token — drop issuer address (admin)' },
  { command:'stop',     description:'Stop tracking (admin)' },
  { command:'stopall',  description:'Stop all tracking (admin)' },
  { command:'list',     description:'Show tracked tokens (admin)' },
  { command:'price',    description:'Live price and market cap' },
  { command:'mc',       description:'Market cap progress bar' },
  { command:'chart',    description:'Chart links' },
  { command:'holders',  description:'Token holder count' },
  { command:'buy',      description:'How to buy guide' },
  { command:'raid',     description:'Launch raid — url likes comments retweets (admin)' },
  { command:'endraid',  description:'End active raid (admin)' },
  { command:'setimage',     description:'Change buy alert image (admin)' },
  { command:'setraidimage', description:'Change raid image (admin)' },
  { command:'addimage', description:'Add hourly image (admin)' },
  { command:'images',   description:'Show image count (admin)' },
  { command:'test',     description:'Send test buy alert (admin)' },
  { command:'help',     description:'Show all commands' },
]).then(() => console.log('✅ Bot commands menu registered'))
  .catch(e => console.error('Commands error:', e.message))

console.log('🪞 $REALITY Bot starting...')
;(async () => {
await loadState()
// Re-subscribe to all tracked tokens after restart
setTimeout(async () => {
  const keys = Object.keys(tracking)
  if (keys.length > 0) {
    console.log('📡 Re-subscribing to', keys.length, 'token(s)...')
    for (const key of keys) {
      try {
        await subscribeToken(tracking[key].issuer)
        console.log('📡 Re-subscribed:', tracking[key].name)
      } catch (e) { console.error('Re-subscribe error:', e.message) }
    }
  }
}, 3000)
connectXRPL().catch(console.error)
})()