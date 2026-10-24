const ORIGEM = Deno.env.get('ALLOWED_ORIGIN') || 'https://campsaboaria.github.io';

const cors = {
  'Access-Control-Allow-Origin': ORIGEM,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  Vary: 'Origin',
};

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

type Item = { nome: string; qtd: number; peso_g: number; tags: string[] };
type Caixa = { comprimento: number; largura: number; altura: number };
type Opcao = { nome: string; valor: number; prazo: number | null };

const ESSENCIAS = ['Mamãe e bebê', 'Giovanna baby', 'Cheirinho de bebê', 'Talco', 'Algodão', 'Bambu', 'Lavanda', 'Flor de cerejeira', 'Cascas e folhas', 'Limão', 'Morango', 'Uva'];
const CORES = ['Azul', 'Amarelo', 'Rosa', 'Verde', 'Vermelho', 'Branco', 'Cinza', 'Bege', 'Marrom'];
const TAGS_OK = ['#palito', '#cartão', '#frasco'];
const CEP_ORIGEM_PADRAO = '13150690';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const limitar = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(n)));
const digitos = (s: unknown) => String(s ?? '').replace(/\D/g, '');
const arred = (n: number) => Math.round(n * 100) / 100;
const texto = (s: unknown, max: number) => String(s ?? '').trim().slice(0, max);

class Recusa extends Error {}

function supabase() {
  const url = Deno.env.get('SUPABASE_URL');
  const chave = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SERVICE_KEY');
  if (!url || !chave) throw new Error('falta a chave de serviço do Supabase (secret SERVICE_KEY)');
  const h: Record<string, string> = { apikey: chave, 'Content-Type': 'application/json' };
  if (chave.startsWith('eyJ')) h.Authorization = `Bearer ${chave}`;
  return { url, h };
}

async function rest(caminho: string, init: RequestInit = {}) {
  const { url, h } = supabase();
  return await fetch(`${url}/rest/v1${caminho}`, {
    ...init,
    headers: { ...h, ...((init.headers as Record<string, string>) || {}) },
    signal: AbortSignal.timeout(15000),
  });
}

async function hmac(t: string): Promise<string> {
  const segredo = Deno.env.get('SIGN_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SERVICE_KEY') || '';
  if (!segredo) throw new Error('falta o secret SIGN_KEY');
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(t));
  return [...new Uint8Array(s)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha(t: string): Promise<string> {
  const s = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return [...new Uint8Array(s)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 20);
}

const iguais = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};

const paraB64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
const deB64 = (s: string) => decodeURIComponent(escape(atob(s)));

async function assinar(o: unknown) {
  const p = paraB64(JSON.stringify(o));
  return `${p}.${await hmac(p)}`;
}

async function conferir(t: unknown) {
  const [p, sig] = String(t || '').split('.');
  if (!p || !sig) return null;
  if (!iguais(sig, await hmac(p))) return null;
  try {
    return JSON.parse(deB64(p));
  } catch (_) {
    return null;
  }
}

type Linha = { id: string; qtd: number; ess: string; cor: string };

function lerLinhas(brutas: unknown): Linha[] {
  if (!Array.isArray(brutas) || brutas.length < 1 || brutas.length > 30) throw new Recusa('carrinho vazio ou grande demais');
  return brutas.map((i: any) => {
    const id = String(i?.id || '');
    if (!UUID.test(id)) throw new Recusa('produto inválido');
    const qtd = Math.round(Number(i?.qtd));
    if (!Number.isFinite(qtd) || qtd < 1 || qtd > 500) throw new Recusa('quantidade inválida');
    const ess = String(i?.ess || '');
    const cor = String(i?.cor || '');
    if (ess && !ESSENCIAS.includes(ess)) throw new Recusa('essência inválida');
    if (cor && !CORES.includes(cor)) throw new Recusa('cor inválida');
    return { id, qtd, ess, cor };
  });
}

async function carregarProdutos(linhas: Linha[]) {
  const ids = [...new Set(linhas.map((l) => l.id))];
  const r = await rest(`/produtos?select=id,nome,preco,peso_g,tags,status,publicar_em,loc&id=in.(${ids.join(',')})`);
  if (!r.ok) throw new Error(`não foi possível ler os produtos (${r.status})`);
  const lista: any[] = await r.json();
  const agora = Date.now();
  const mapa: Record<string, any> = {};
  for (const p of lista) {
    const visivel = p.status === 'publicado' || (p.status === 'agendado' && p.publicar_em && Date.parse(p.publicar_em) <= agora);
    if (visivel && [1, 4, 5].includes(p.loc) && Number(p.preco) > 0 && Number(p.peso_g) > 0) mapa[p.id] = p;
  }
  return linhas.map((l) => {
    const p = mapa[l.id];
    if (!p) throw new Recusa('um dos produtos não está mais disponível');
    return { ...l, nome: String(p.nome), preco: Number(p.preco), peso_g: Number(p.peso_g), tags: ((p.tags as string[]) || []).filter((t) => TAGS_OK.includes(t)) };
  });
}

function estimar(itens: Item[]): Caixa {
  let v = 0;
  for (const i of itens) {
    const base = i.tags.includes('#frasco') ? 220 : i.tags.includes('#palito') ? 140 : i.tags.includes('#cartão') ? 70 : 100;
    v += base * i.qtd;
  }
  v *= 1.35;
  const comprimento = limitar(Math.cbrt(v) * 1.7, 16, 100);
  const largura = limitar(Math.cbrt(v) * 1.2, 11, 100);
  const altura = limitar(v / (comprimento * largura), 2, 100);
  return { comprimento, largura, altura };
}

async function estimarComIA(itens: Item[], pesoKg: number): Promise<Caixa> {
  const key = Deno.env.get('OLLAMA_API_KEY');
  if (!key) throw new Error('sem chave da IA');
  const lista = itens.map((i) => `- ${i.qtd}x ${i.nome} (${i.peso_g} g cada) tags: ${i.tags.join(' ') || 'nenhuma'}`).join('\n');
  const r = await fetch('https://ollama.com/api/chat', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      model: Deno.env.get('OLLAMA_MODEL') || 'gpt-oss:120b',
      stream: false,
      messages: [
        {
          role: 'system',
          content:
            'Você ajuda uma loja de lembrancinhas artesanais a escolher a menor caixa de papelão para envio pelos Correios. ' +
            'Tags: #palito = lembrancinha em palito (peça comprida e fina, como tulipas); #cartão = lembrancinha em cartão plano (chata e empilhável); ' +
            '#frasco = frasco de aromatizador ou sabonete líquido (rígido, volumoso e frágil). ' +
            'Considere proteção para itens frágeis. Responda SOMENTE com JSON neste formato: ' +
            '{"comprimento_cm":numero,"largura_cm":numero,"altura_cm":numero}. ' +
            'Limites: comprimento de 16 a 100, largura de 11 a 100, altura de 2 a 100, e a soma das três medidas até 180.',
        },
        { role: 'user', content: `Itens do pedido:\n${lista}\nPeso total: ${pesoKg.toFixed(2)} kg` },
      ],
    }),
  });
  if (!r.ok) throw new Error('IA ' + r.status);
  const j = await r.json();
  const m = String(j?.message?.content || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('resposta da IA sem JSON');
  const o = JSON.parse(m[0]);
  const c = Number(o.comprimento_cm), l = Number(o.largura_cm), a = Number(o.altura_cm);
  if (![c, l, a].every((n) => Number.isFinite(n) && n > 0)) throw new Error('medidas inválidas');
  const caixa = { comprimento: limitar(c, 16, 100), largura: limitar(l, 11, 100), altura: limitar(a, 2, 100) };
  if (caixa.comprimento + caixa.largura + caixa.altura > 180) throw new Error('caixa acima do limite');
  return caixa;
}

async function cotarME(cep: string, origem: string, c: Caixa, pesoKg: number): Promise<Opcao[]> {
  const token = Deno.env.get('ME_TOKEN');
  const email = Deno.env.get('ME_EMAIL') || 'contato@exemplo.com';
  if (!token) throw new Error('falta o token do Melhor Envio (ME_TOKEN)');
  const base = Deno.env.get('ME_URL') || 'https://melhorenvio.com.br';
  const r = await fetch(`${base}/api/v2/me/shipment/calculate`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': `CampSaboaria (${email})`,
    },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      from: { postal_code: origem },
      to: { postal_code: cep },
      package: { height: c.altura, width: c.largura, length: c.comprimento, weight: pesoKg },
      options: { receipt: false, own_hand: false, collect: false },
      services: Deno.env.get('ME_SERVICOS') || '1,2',
    }),
  });
  if (!r.ok) throw new Error('Melhor Envio ' + r.status);
  const lista = await r.json();
  return (Array.isArray(lista) ? lista : [])
    .filter((s: any) => !s.error && (s.custom_price ?? s.price))
    .map((s: any) => ({
      nome: `${s.company?.name === 'Correios' ? 'Correios ' : ''}${s.name}`.trim(),
      valor: Number(s.custom_price ?? s.price),
      prazo: Number(s.custom_delivery_time ?? s.delivery_time) || null,
    }))
    .sort((a: Opcao, b: Opcao) => a.valor - b.valor);
}

async function cotarItens(linhas: any[], cep: string, origem: string) {
  const itens: Item[] = linhas.map((l) => ({ nome: l.nome, qtd: l.qtd, peso_g: l.peso_g, tags: l.tags }));
  const pesoItens = itens.reduce((a, i) => a + i.peso_g * i.qtd, 0);
  const pesoKg = Math.max(0.1, (pesoItens + 80) / 1000);
  let fonte = 'ia';
  let caixa: Caixa;
  try {
    caixa = await estimarComIA(itens, pesoKg);
  } catch (_) {
    fonte = 'estimativa';
    caixa = estimar(itens);
  }
  const opcoes = await cotarME(cep, origem, caixa, pesoKg);
  if (!opcoes.length) throw new Recusa('nenhuma opção de envio para este CEP');
  return { caixa: { ...caixa, peso_kg: arred(pesoKg), fonte }, opcoes };
}

const chaveItens = (linhas: Linha[]) =>
  sha(linhas.map((l) => `${l.id}:${l.qtd}`).sort().join(','));

function origemDe(b: any) {
  const o = digitos(Deno.env.get('CEP_ORIGEM') || b.origem || CEP_ORIGEM_PADRAO);
  if (o.length !== 8) throw new Recusa('CEP de origem inválido');
  return o;
}

async function acaoCotar(b: any) {
  const cep = digitos(b.cep);
  if (cep.length !== 8) throw new Recusa('CEP inválido');
  const origem = origemDe(b);
  const linhas = lerLinhas(b.itens);
  const itens = await carregarProdutos(linhas);
  const q = await cotarItens(itens, cep, origem);
  const cotacao = await assinar({ cep, origem, h: await chaveItens(linhas), opcoes: q.opcoes, caixa: q.caixa, exp: Date.now() + 30 * 60 * 1000 });
  return { origem, caixa: q.caixa, opcoes: q.opcoes, cotacao };
}

function gerarCodigo() {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return 'CS-' + [...a].map((x) => ALFABETO[x % ALFABETO.length]).join('');
}

async function acaoPedido(b: any) {
  const linhas = lerLinhas(b.itens);
  const itens = await carregarProdutos(linhas);
  const subtotal = arred(itens.reduce((a, i) => a + i.preco * i.qtd, 0));
  const pesoG = itens.reduce((a, i) => a + i.peso_g * i.qtd, 0);
  const cep = digitos(b.cep);

  let frete: Opcao | null = null;
  let caixa: unknown = null;
  let origem = '';
  let avisoFrete = '';
  if (b.retirada && Deno.env.get('PERMITE_RETIRADA') === '1') {
    frete = { nome: 'Retirar na loja', valor: 0, prazo: null };
  } else if (b.cotacao) {
    const c = await conferir(b.cotacao);
    if (!c) avisoFrete = 'cotação inválida';
    else if (Date.now() > Number(c.exp)) avisoFrete = 'cotação vencida';
    else if (c.cep !== cep || c.h !== (await chaveItens(linhas))) avisoFrete = 'cotação não confere com o pedido';
    else {
      const escolhida = (c.opcoes as Opcao[]).find((o) => o.nome === String(b.frete_escolhido || ''));
      if (escolhida) {
        frete = { nome: escolhida.nome, valor: arred(Number(escolhida.valor)), prazo: escolhida.prazo ?? null };
        caixa = c.caixa;
        origem = String(c.origem || '');
      } else avisoFrete = 'opção de frete não encontrada';
    }
  }
  const total = arred(subtotal + (frete ? frete.valor : 0));
  const registro = {
    nome: texto(b.nome, 80),
    endereco: texto(b.endereco, 240),
    cep,
    destino: texto(b.destino, 80),
    pagamento: texto(b.pagamento, 30),
    observacoes: texto(b.obs, 600),
    itens: itens.map((i) => ({ id: i.id, nome: i.nome, ess: i.ess, cor: i.cor, qtd: i.qtd, preco: i.preco, peso_g: i.peso_g, total: arred(i.preco * i.qtd) })),
    subtotal,
    frete_nome: frete ? frete.nome : null,
    frete_valor: frete ? frete.valor : null,
    frete_prazo: frete ? frete.prazo : null,
    total,
    peso_g: pesoG,
    caixa,
  };
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const codigo = gerarCodigo();
    const r = await rest('/pedidos', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...registro, codigo }) });
    if (r.status === 409) continue;
    if (!r.ok) throw new Error(`não foi possível registrar o pedido (${r.status})`);
    const linha = (await r.json())[0] || {};
    return { codigo, criado: linha.criado || new Date().toISOString(), ...registro, origem, avisoFrete };
  }
  throw new Error('não foi possível gerar o código do pedido');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const origemReq = req.headers.get('origin');
  if (origemReq && origemReq !== ORIGEM) return json({ erro: 'origem não permitida' }, 403);
  const chaveSite = Deno.env.get('SITE_KEY');
  if (chaveSite && req.headers.get('apikey') !== chaveSite) return json({ erro: 'chave inválida' }, 401);
  try {
    const b = await req.json();
    if (b.acao === 'pedido') return json(await acaoPedido(b));
    return json(await acaoCotar(b));
  } catch (e) {
    const recusa = e instanceof Recusa;
    return json({ erro: String((e as Error).message || e) }, recusa ? 422 : 400);
  }
});
