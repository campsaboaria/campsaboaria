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

const TAGS_OK = ['#palito', '#cartão', '#frasco'];
const CEP_ORIGEM_PADRAO = '13150690';
const limitar = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(n)));

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
  const lista = itens
    .map((i) => `- ${i.qtd}x ${i.nome} (${i.peso_g} g cada) tags: ${i.tags.join(' ') || 'nenhuma'}`)
    .join('\n');
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
  const txt: string = j?.message?.content || '';
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('resposta da IA sem JSON');
  const o = JSON.parse(m[0]);
  const c = Number(o.comprimento_cm), l = Number(o.largura_cm), a = Number(o.altura_cm);
  if (![c, l, a].every((n) => Number.isFinite(n) && n > 0)) throw new Error('medidas inválidas');
  const caixa = { comprimento: limitar(c, 16, 100), largura: limitar(l, 11, 100), altura: limitar(a, 2, 100) };
  if (caixa.comprimento + caixa.largura + caixa.altura > 180) throw new Error('caixa acima do limite');
  return caixa;
}

async function cotar(cep: string, origem: string, c: Caixa, pesoKg: number) {
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
    .sort((a: any, b: any) => a.valor - b.valor);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const origemReq = req.headers.get('origin');
  if (origemReq && origemReq !== ORIGEM) return json({ erro: 'origem não permitida' }, 403);
  const chaveSite = Deno.env.get('SITE_KEY');
  if (chaveSite && req.headers.get('apikey') !== chaveSite) return json({ erro: 'chave inválida' }, 401);
  try {
    const body = await req.json();
    const cep = String(body.cep || '').replace(/\D/g, '');
    if (cep.length !== 8) return json({ erro: 'CEP inválido' }, 400);
    const origem = (Deno.env.get('CEP_ORIGEM') || String(body.origem || '') || CEP_ORIGEM_PADRAO).replace(/\D/g, '');
    if (origem.length !== 8) return json({ erro: 'CEP de origem inválido' }, 400);
    if (!Array.isArray(body.itens) || body.itens.length < 1 || body.itens.length > 50) return json({ erro: 'itens inválidos' }, 400);
    const itens: Item[] = body.itens.map((i: any) => ({
      nome: String(i.nome || '').slice(0, 80),
      qtd: limitar(Number(i.qtd), 1, 500),
      peso_g: limitar(Number(i.peso_g), 0, 30000),
      tags: (Array.isArray(i.tags) ? i.tags : []).filter((t: string) => TAGS_OK.includes(t)),
    }));
    if (itens.some((i) => i.peso_g <= 0)) return json({ erro: 'item sem peso cadastrado' }, 400);
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
    const opcoes = await cotar(cep, origem, caixa, pesoKg);
    if (!opcoes.length) return json({ erro: 'nenhuma opção de envio para este CEP' }, 422);
    return json({ origem, caixa: { ...caixa, peso_kg: Math.round(pesoKg * 100) / 100, fonte }, opcoes });
  } catch (e) {
    return json({ erro: String((e as Error).message || e) }, 400);
  }
});
