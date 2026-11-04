/*
 * Organisations that publish technical reports, by the short name a tag shows, with the other names their reports
 * go by. `logo` names an SVG in renderer/src/assets/orgs: marks from LobeHub's icon set (MIT), Simple Icons (CC0),
 * theSVG (MIT) and Gil Barbara's logos (CC0). Organisations whose mark is only lettering get no logo; at text size it
 * can't be read, and the name is beside it anyway.
 */

export interface Org {
  name: string
  aliases?: string[]
  logo?: string
  /** A mark too dark to see on the dark theme, drawn in the text colour there */
  monoDark?: boolean
}

export const ORGS: Org[] = [
  { name: 'OpenAI', logo: 'openai' },
  { name: 'Anthropic', logo: 'anthropic' },
  { name: 'Google DeepMind', aliases: ['DeepMind', 'GDM'], logo: 'googledeepmind' },
  { name: 'Google', aliases: ['Google Research', 'Google Brain'], logo: 'google' },
  { name: 'Meta', aliases: ['Meta AI', 'AI at Meta', 'FAIR', 'Facebook', 'Facebook AI Research', 'Llama Team'], logo: 'meta' },
  { name: 'Microsoft', aliases: ['Microsoft Research', 'MSR'], logo: 'microsoft' },
  { name: 'Apple', logo: 'apple' },
  { name: 'Amazon', aliases: ['Amazon AGI', 'AWS'] },
  { name: 'NVIDIA', logo: 'nvidia' },
  { name: 'IBM', aliases: ['IBM Research'], logo: 'ibm' },
  { name: 'Intel', aliases: ['Intel Labs'] },
  { name: 'AMD' },
  { name: 'Qualcomm', aliases: ['Qualcomm AI Research'], logo: 'qualcomm' },
  { name: 'Samsung', aliases: ['Samsung Research'] },
  { name: 'LG', aliases: ['LG AI Research'], logo: 'lg' },
  { name: 'Naver', aliases: ['Naver Cloud'], logo: 'naver' },
  { name: 'Sony', aliases: ['Sony AI'] },
  { name: 'Salesforce', aliases: ['Salesforce Research', 'Salesforce AI Research'], logo: 'salesforce' },
  { name: 'ServiceNow', aliases: ['ServiceNow Research'], logo: 'servicenow' },
  { name: 'LinkedIn', logo: 'linkedin' },
  { name: 'Snowflake', aliases: ['Snowflake AI Research'], logo: 'snowflake' },
  { name: 'Databricks', aliases: ['Mosaic', 'MosaicML'], logo: 'databricks' },
  { name: 'Adobe', aliases: ['Adobe Research'], logo: 'adobe' },
  { name: 'xAI', logo: 'xai' },
  { name: 'Mistral AI', aliases: ['Mistral'], logo: 'mistral' },
  { name: 'Cohere', aliases: ['Cohere For AI', 'Cohere Labs'], logo: 'cohere' },
  { name: 'AI21', aliases: ['AI21 Labs'], logo: 'ai21' },
  { name: 'Ai2', aliases: ['Allen AI', 'AllenAI', 'Allen Institute for AI'], logo: 'ai2' },
  { name: 'Hugging Face', aliases: ['HuggingFace'], logo: 'huggingface' },
  { name: 'TII', aliases: ['Technology Innovation Institute'], logo: 'tii' },
  { name: 'Sakana AI', aliases: ['Sakana'], logo: 'sakanaai' },
  { name: 'Reka', aliases: ['Reka AI'], logo: 'reka' },
  { name: 'Liquid AI', aliases: ['Liquid'], logo: 'liquidai' },
  { name: 'Nous Research', aliases: ['Nous'], logo: 'nousresearch' },
  { name: 'Upstage', logo: 'upstage' },
  { name: 'Stability AI', aliases: ['Stability'], logo: 'stabilityai' },
  { name: 'Black Forest Labs', aliases: ['BFL'], logo: 'blackforestlabs' },
  { name: 'Runway', logo: 'runway' },
  { name: 'Luma AI', aliases: ['Luma'], logo: 'lumaai' },
  { name: 'Cerebras', logo: 'cerebras' },
  { name: 'Yandex', logo: 'yandex' },
  { name: 'Arcee', aliases: ['Arcee AI'], logo: 'arcee' },
  { name: 'Essential AI', logo: 'essentialai', monoDark: true },
  { name: 'Poolside', logo: 'poolside' },
  { name: 'Alibaba', aliases: ['Alibaba Group', 'Alibaba Cloud', 'DAMO Academy'], logo: 'alibaba' },
  { name: 'Qwen', aliases: ['Qwen Team'], logo: 'qwen' },
  { name: 'DeepSeek', aliases: ['DeepSeek-AI', 'DeepSeek AI'], logo: 'deepseek' },
  { name: 'ByteDance', aliases: ['ByteDance Seed', 'Seed', 'Doubao'], logo: 'bytedance' },
  { name: 'Tencent', aliases: ['Tencent Hunyuan', 'Hunyuan'], logo: 'tencent' },
  { name: 'Baidu', aliases: ['ERNIE'], logo: 'baidu' },
  { name: 'Moonshot AI', aliases: ['Moonshot', 'Kimi', 'Kimi Team'], logo: 'moonshotai' },
  { name: 'Zhipu AI', aliases: ['Zhipu', 'Z.ai', 'GLM', 'THUDM'], logo: 'zhipuai' },
  { name: 'MiniMax', logo: 'minimax' },
  { name: 'StepFun', logo: 'stepfun' },
  { name: '01.AI', aliases: ['01AI', 'Yi'], logo: '01ai' },
  { name: 'Baichuan', aliases: ['Baichuan AI', 'Baichuan Inc'], logo: 'baichuan' },
  { name: 'Xiaomi', aliases: ['Xiaomi LLM-Core Team', 'MiMo'], logo: 'xiaomi' },
  { name: 'Meituan', aliases: ['Meituan LongCat Team', 'LongCat'], logo: 'meituan' },
  { name: 'Kuaishou', aliases: ['Kwai', 'Kuaishou Technology', 'Kling'], logo: 'kuaishou' },
  { name: 'Ant Group', aliases: ['Inclusion AI', 'InclusionAI', 'Ant Ling'], logo: 'antgroup' },
  { name: 'Xiaohongshu', aliases: ['RedNote', 'rednote'] },
  { name: 'Bilibili', logo: 'bilibili' },
  { name: 'Huawei', aliases: ["Huawei Noah's Ark Lab", 'Pangu'], logo: 'huawei' },
  { name: 'iFlytek', aliases: ['iFlytek Spark'], logo: 'iflytek' },
  { name: 'SenseTime', aliases: ['SenseNova'], logo: 'sensetime' },
  { name: 'Shanghai AI Lab', aliases: ['Shanghai AI Laboratory', 'Shanghai Artificial Intelligence Laboratory', 'InternLM'], logo: 'shanghaiailab' },
  { name: 'BAAI', aliases: ['Beijing Academy of Artificial Intelligence'], logo: 'baai' },
  { name: 'Kunlun Skywork', aliases: ['Skywork', 'Skywork AI', 'Kunlun'], logo: 'kunlunskywork' },
  { name: '360', aliases: ['Qihoo 360', '360 AI'], logo: '360' },
  { name: 'ZTE' },
  { name: 'OPPO' },
  { name: 'vivo' },
  { name: 'Honor' },
  { name: 'Lenovo' },
  { name: 'JD', aliases: ['JD.com', 'JD Explore Academy'] },
  { name: 'China Mobile' },
  { name: 'China Telecom', aliases: ['TeleAI'] }
]

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const byKey = new Map<string, Org>()
for (const o of ORGS) for (const n of [o.name, ...(o.aliases ?? [])]) byKey.set(key(n), o)

/** The organisation a name refers to, also when it carries a trailing "Team", "Research" or "Lab". */
export function findOrg(name: string): Org | undefined {
  const k = key(name)
  return byKey.get(k) ?? byKey.get(key(name.replace(/\b(team|research|labs?|inc\.?|group)\s*$/i, '')))
}
