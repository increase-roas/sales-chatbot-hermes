// Local demo chat for Alex (2026-10-15): talk to the bot in a browser, draft-only.
// Same reply path as the webhook and scripts/eval-agent.ts: the shipped SALES_INSTRUCTIONS, the same tools, rep examples
// (SELECT only), guardReply, then applySalesRules. Never sends an SMS, never writes to any database or CRM.
// The conversation lives only in the browser tab.
//
// Usage: node --env-file=.env --experimental-strip-types scripts/demo-chat.ts
//        then open http://127.0.0.1:4180
// DEMO_MODEL overrides the model (default: the production Fireworks model), e.g. a provider/model string the
// Mastra model router accepts when its API key is in the environment.

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { Agent } from '@mastra/core/agent'
import { RequestContext } from '@mastra/core/request-context'
import pg from 'pg'

import { SALES_INSTRUCTIONS } from '../src/mastra/agents/sales-agent.ts'
import { hasAddress, inferDealState } from '../src/mastra/deal-state.ts'
import { applySalesRules, pastQuote } from '../src/mastra/sales-rules.ts'
import { guardReply } from '../src/mastra/guard.ts'
import { examplesBlock, similarRepExamples } from '../src/mastra/rep-examples.ts'
import { threadLine } from '../src/mastra/text.ts'
import { bookInstall, proposeDate, quotePrice } from '../src/mastra/tools/deal-tools.ts'
import { lookupProspect } from '../src/mastra/tools/lookup-prospect.ts'
import { showInstallPhoto } from '../src/mastra/tools/show-photo.ts'
import { showRapportPhoto } from '../src/mastra/tools/show-rapport.ts'
import { PHOTOS, RAPPORT, speakerName } from '../src/mastra/photos.ts'
import { spendGuard } from './fw-guard.ts'

const PORT = Number(process.env.DEMO_PORT ?? 4180)
const MODEL = process.env.DEMO_MODEL ?? 'fireworks-ai/accounts/fireworks/models/qwen3p8-2p4t-a95b'
const PHOTO_DIR = join(homedir(), 'Documents/BUSINESS 1 - Increase ROAS/Clients & Projects/Dynamite Lights/bot-photos-20261015/library')

// No CRM reads or sends from the demo.
delete process.env.GHL_API_KEY
delete process.env.GHL_SEND_ENABLED
delete process.env.JOBBER_ACCESS_TOKEN

const agent = new Agent({
  id: 'sales-agent-demo',
  name: 'Sales Rep (demo)',
  instructions: SALES_INSTRUCTIONS,
  model: MODEL,
  tools: { lookupProspect, quotePrice, proposeDate, bookInstall, showInstallPhoto, showRapportPhoto },
})

const pool = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 }) : null
const readOnly = {
  none: async () => { throw new Error('read-only demo') },
  any: async <T,>(q: string, v?: unknown[]) => {
    if (!/^\s*SELECT/i.test(q)) throw new Error('read-only demo')
    return (await pool!.query(q, v as unknown[])).rows as T[]
  },
}

type Turn = { role: 'user' | 'assistant'; content: string; photoId?: string }

export async function draftReply(history: Turn[], message: string, leadKey: string) {
  const prior = history.map(m => threadLine({ role: m.role, content: m.content })).filter(Boolean).join('\n')
  const photosSent = history.map(m => m.photoId).filter(Boolean) as string[]
  const requestContext = new RequestContext()
  requestContext.set('dealState', inferDealState(prior, message))
  requestContext.set('photosSent', photosSent)
  requestContext.set('photoIncludePending', false)
  requestContext.set('customerTurns', history.filter(m => m.role === 'user').length + 1)
  requestContext.set('leadKey', leadKey)
  requestContext.set('speakerName', speakerName(history.filter(m => m.role === 'assistant').map(m => m.content).join('\n')))
  let examples = ''
  if (pool) examples = examplesBlock(await similarRepExamples(readOnly, message, 5).catch(() => []))
  const result = await agent.generate([...history.map(m => ({ role: m.role, content: m.content })), { role: 'user' as const, content: message }], {
    requestContext,
    maxSteps: 5,
    instructions: [SALES_INSTRUCTIONS, `Your name in this conversation: ${requestContext.get('speakerName')}.`, examples].filter(Boolean).join('\n\n'),
  })
  const base = guardReply(message, result.text ?? '', prior)
  const post = pastQuote(`${prior}\n${message}`)
  const ruled = base.needsHuman ? { reply: base.reply, blocked: [] as string[] } : applySalesRules(message, base.reply, hasAddress(prior, message) || post, post)
  const blocked = [...base.blocked, ...ruled.blocked]
  const picked = (requestContext.get('photoPicked') as string | undefined) ?? ''
  const photoId = blocked.some(b => b !== 'dash') || photosSent.includes(picked) ? '' : picked
  return { reply: ruled.reply, needsHuman: base.needsHuman, blocked, photoId, dealState: requestContext.get('dealState') }
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dynamite bot demo</title><style>
body{margin:0;font:16px -apple-system,system-ui,sans-serif;background:#f2f2f7;color:#111}
header{padding:12px 16px;background:#fff;border-bottom:1px solid #ddd}header small{color:#666;display:block}
#log{padding:16px;display:flex;flex-direction:column;gap:8px;max-width:640px;margin:0 auto 90px}
.m{max-width:78%;padding:9px 13px;border-radius:18px;white-space:pre-wrap}.user{align-self:flex-end;background:#0a84ff;color:#fff}
.assistant{align-self:flex-start;background:#e5e5ea}.meta{align-self:flex-start;font-size:12px;color:#888;margin-top:-4px}
.m img{max-width:220px;border-radius:12px;display:block;margin-top:6px}
form{position:fixed;bottom:0;left:0;right:0;display:flex;gap:8px;padding:12px 16px;background:#fff;border-top:1px solid #ddd}
input{flex:1;font:inherit;padding:10px 14px;border:1px solid #ccc;border-radius:20px}button{font:inherit;padding:10px 16px;border:0;border-radius:20px;background:#0a84ff;color:#fff}
</style></head><body><header><b>Dynamite bot demo</b><small>Draft-only: nothing is texted or saved. Model: ${MODEL.replace(/^.*\//, '')}. <a href="#" id="reset">New conversation</a></small></header>
<div id="log"></div><form id="f"><input id="t" autocomplete="off" placeholder="Text the bot like a homeowner would"><button>Send</button></form>
<script>
let history=[];const log=document.getElementById('log'),t=document.getElementById('t');const key='demo-'+Math.random().toString(36).slice(2,8);
function add(role,text,photo,meta){const d=document.createElement('div');d.className='m '+role;d.textContent=text||'(no reply)';
if(photo){const i=document.createElement('img');i.src='/photo/'+encodeURIComponent(photo);d.appendChild(i)}log.appendChild(d);
if(meta){const s=document.createElement('div');s.className='meta';s.textContent=meta;log.appendChild(s)}scrollTo(0,document.body.scrollHeight)}
document.getElementById('reset').onclick=e=>{e.preventDefault();history=[];log.innerHTML=''};
document.getElementById('f').onsubmit=async e=>{e.preventDefault();const msg=t.value.trim();if(!msg)return;t.value='';add('user',msg);
const r=await fetch('/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({history,message:msg,key})}).then(r=>r.json()).catch(e=>({error:String(e)}));
history.push({role:'user',content:msg});
if(r.error){add('assistant','',null,'error: '+r.error);return}
add('assistant',r.reply,r.photoId,[r.needsHuman?'would go to a person':'',r.blocked&&r.blocked.length?'rules fixed: '+r.blocked.join(', '):'',r.dealState].filter(Boolean).join(' · '));
history.push({role:'assistant',content:r.reply,photoId:r.photoId||undefined})};
</script></body></html>`

const photoFile = (id: string) => [...PHOTOS, ...RAPPORT].find(p => p.id === id)?.file

createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE)
      return
    }
    if (req.method === 'GET' && req.url?.startsWith('/photo/')) {
      const file = photoFile(decodeURIComponent(req.url.slice(7)))
      if (!file) return void res.writeHead(404).end()
      res.writeHead(200, { 'content-type': 'image/jpeg' }).end(readFileSync(join(PHOTO_DIR, file.replace(/^.*\//, ''))))
      return
    }
    if (req.method === 'POST' && req.url === '/chat') {
      // Paid model call: respect the spend guard (config/spend.json).
      const g = spendGuard()
      if (!g.ok) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `paused to save Fireworks credit: ${g.why.replace(/ \|.*$/, '')}` }))
      let body = ''
      for await (const chunk of req) body += chunk
      const { history = [], message = '', key = 'demo' } = JSON.parse(body || '{}') as { history?: Turn[]; message?: string; key?: string }
      const out = await draftReply(history.slice(-30), String(message).slice(0, 1000), String(key))
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out))
      return
    }
    res.writeHead(404).end()
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown'
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ error: /suspended|412/i.test(msg) ? 'model provider unavailable (Fireworks account suspended)' : msg.slice(0, 200) }))
  }
}).listen(PORT, '127.0.0.1', () => console.log(`demo chat on http://127.0.0.1:${PORT} (model ${MODEL}, draft-only)`))
