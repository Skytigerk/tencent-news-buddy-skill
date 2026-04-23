#!/usr/bin/env node
// scripts/news-buddy.cjs — 腾讯新闻搭子核心执行脚本
// 功能：画像管理（初始化/更新/迭代）、新闻数据存储、已展示记录管理
// 设计理念：画像对用户不可见，所有隐私信息脱敏存储，通过对话自然迭代

'use strict';

const fs = require('fs');
const path = require('path');

// ==================== 路径 ====================
const SKILL_DIR = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(SKILL_DIR, '.cache');
const PROFILE_FILE = path.join(CACHE_DIR, 'profile.json');
const NEWS_FILE = path.join(CACHE_DIR, 'news.json');
const SHOWN_FILE = path.join(CACHE_DIR, 'shown.json');
const HISTORY_DIR = path.join(CACHE_DIR, 'history');
const TEMPLATES_FILE = path.join(SKILL_DIR, 'data', 'profile-templates.json');

// 确保缓存目录存在
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

// ==================== 画像脱敏映射 ====================
const DESENSITIZE_MAP = {
  // 年龄 → 人生阶段
  age: {
    ranges: [
      { min: 0, max: 22, label: '求学探索期新锐' },
      { min: 23, max: 28, label: '职场成长期新锐' },
      { min: 29, max: 35, label: '职场中坚力量' },
      { min: 36, max: 45, label: '成熟期社会中坚' },
      { min: 46, max: 55, label: '事业成熟期精英' },
      { min: 56, max: 120, label: '阅历丰富的社会前辈' },
    ],
  },
  // 城市 → 城市层级
  city: {
    tier1: ['北京', '上海', '广州', '深圳'],
    newTier1: ['成都', '杭州', '武汉', '南京', '重庆', '苏州', '西安', '长沙', '天津', '郑州', '东莞', '青岛', '昆明', '沈阳', '宁波', '合肥'],
    tier2: ['佛山', '无锡', '厦门', '大连', '济南', '福州', '温州', '石家庄', '哈尔滨', '珠海'],
  },
  // 职业 → 行业背景
  job: {
    'programmer|程序员|开发|前端|后端|全栈|码农|工程师|架构师': 'IT互联网背景',
    '产品经理|产品|PM': 'IT互联网产品背景',
    '设计师|设计|UI|UX': '创意设计背景',
    '公务员|事业单位|政府|体制内': '公共服务领域',
    '老师|教师|教育|教授': '教育行业背景',
    '医生|护士|医疗|医院': '医疗健康行业',
    '金融|银行|证券|基金|会计|财务': '金融财经背景',
    '律师|法律|法务': '法律行业背景',
    '销售|运营|市场|营销': '商业运营背景',
    '骑手|快递|外卖|工人|工厂|制造': '实干型劳动者',
    '个体|老板|创业|自营': '创业/个体经营者',
    '自由职业|freelance|自媒体|博主': '自由职业/内容创作者',
    '学生': '在校学生',
    '退休': '退休人士',
  },
};

// ==================== 常量 ====================
const MAX_INTERESTS_PER_CATEGORY = 12;   // 每个兴趣类别最多保留 12 个
const DECAY_HALF_LIFE_DAYS = 30;         // 权重半衰期 30 天
const MIN_WEIGHT_THRESHOLD = 0.15;       // 低于此权重的兴趣会被自动清理
const DEFAULT_WEIGHT = 1.0;              // 新增兴趣的默认权重
const BOOST_INCREMENT = 0.3;             // 重复提及时的权重增幅

const MAX_NOTES_CHARS = 500;             // notes 自由文本字段上限

// ==================== 工具函数 ====================
function getTodayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}

function loadJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return null;
}

function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ==================== 兴趣权重与衰减 ====================

/**
 * 将旧格式兴趣迁移为新格式（带权重+时间戳+sentiment）
 * sentiment: "positive"(默认) | "skeptical"(用户表达怀疑但未明确否定)
 */
function migrateInterests(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(item => {
    if (typeof item === 'string') {
      return { tag: item, weight: DEFAULT_WEIGHT, added_at: new Date().toISOString(), sentiment: 'positive' };
    }
    return {
      tag: item.tag || '',
      weight: typeof item.weight === 'number' ? item.weight : DEFAULT_WEIGHT,
      added_at: item.added_at || new Date().toISOString(),
      sentiment: item.sentiment || 'positive',
    };
  });
}

/**
 * 从带权重的兴趣数组中提取纯标签列表（仅 positive，skeptical 的不参与搜索维度推断）
 */
function interestTags(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(item => typeof item === 'string' || (item.sentiment || 'positive') === 'positive')
    .map(item => typeof item === 'string' ? item : (item.tag || ''));
}

/**
 * 对兴趣数组执行时间衰减，清理低权重项，按权重降序排序，截断到上限
 */
function decayAndPrune(interests) {
  const now = Date.now();
  const result = [];
  for (const item of interests) {
    const addedTime = new Date(item.added_at).getTime();
    // 保护：无效日期按"刚添加"处理
    const ageDays = Number.isNaN(addedTime) ? 0 : (now - addedTime) / (1000 * 60 * 60 * 24);
    // 指数衰减：weight * 0.5^(ageDays / halfLife)
    const decayedWeight = item.weight * Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
    if (decayedWeight >= MIN_WEIGHT_THRESHOLD) {
      result.push({ ...item, weight: Math.round(decayedWeight * 1000) / 1000 });
    }
  }
  // 按权重降序排序
  result.sort((a, b) => b.weight - a.weight);
  // 截断到上限
  return result.slice(0, MAX_INTERESTS_PER_CATEGORY);
}

/**
 * 近义词模糊匹配：判断新标签是否与已有标签语义重复
 * 规则：
 * 1. 去掉"与"/"和"/空格后完全相同 → 重复
 * 2. 一方是另一方的子串 → 重复（如 "AI" 命中 "AI与大模型"）
 * 3. 两个标签共享核心词根（中文2字以上 or 英文3字母以上）→ 重复
 */
function findSimilarInterest(interests, newTag) {
  const normalize = s => s.replace(/与|和|\s/g, '').toLowerCase();
  const normNew = normalize(newTag);
  
  // 提取核心词根（中文2字以上的词 + 英文3字母以上的词）
  function extractRoots(s) {
    const roots = new Set();
    // 英文词根
    const engMatches = s.match(/[a-zA-Z]{3,}/gi) || [];
    for (const m of engMatches) roots.add(m.toLowerCase());
    // 中文：按2字滑窗（简化的核心词提取）
    const cn = s.replace(/[a-zA-Z0-9\s]/g, '');
    if (cn.length >= 2) roots.add(cn);
    return roots;
  }

  const newRoots = extractRoots(newTag);

  for (const item of interests) {
    const normExist = normalize(item.tag);
    // 规则1：归一化后完全相同
    if (normExist === normNew) return item;
    // 规则2：子串匹配
    if (normExist.includes(normNew) || normNew.includes(normExist)) return item;
    // 规则3：核心词根交集
    const existRoots = extractRoots(item.tag);
    for (const root of newRoots) {
      if (existRoots.has(root)) return item;
    }
  }
  return null;
}

/**
 * 向兴趣数组添加一项（带近义词检测 + 权重提升 + sentiment + 上限裁剪）
 */
function addInterest(interests, newTag, sentiment) {
  sentiment = sentiment || 'positive';
  const migrated = migrateInterests(interests);
  const existing = findSimilarInterest(migrated, newTag);
  if (existing) {
    // 已有近义兴趣 → 提升权重并刷新时间和 sentiment
    existing.weight = Math.min(existing.weight + BOOST_INCREMENT, 2.0);
    existing.added_at = new Date().toISOString();
    existing.sentiment = sentiment;
    return { interests: decayAndPrune(migrated), action: 'boosted' };
  }
  // 新兴趣 → 追加
  migrated.push({ tag: newTag, weight: DEFAULT_WEIGHT, added_at: new Date().toISOString(), sentiment });
  return { interests: decayAndPrune(migrated), action: 'added' };
}

/**
 * 从兴趣数组移除一项（支持模糊匹配）
 * 返回 { interests, action } — action 为 'removed' | 'not_found'
 */
function removeInterest(interests, tagToRemove) {
  const migrated = migrateInterests(interests);
  const target = findSimilarInterest(migrated, tagToRemove);
  if (target) {
    const filtered = migrated.filter(item => item !== target);
    return { interests: filtered, action: 'removed' };
  }
  return { interests: migrated, action: 'not_found' };
}

// ==================== 画像脱敏处理 ====================
function desensitizeAge(text) {
  const ageMatch = text.match(/(\d{1,3})\s*岁/);
  if (!ageMatch) return null;
  const age = parseInt(ageMatch[1]);
  for (const range of DESENSITIZE_MAP.age.ranges) {
    if (age >= range.min && age <= range.max) {
      return range.label;
    }
  }
  return '社会活跃期成员';
}

function desensitizeCity(text) {
  for (const city of DESENSITIZE_MAP.city.tier1) {
    if (text.includes(city)) return '一线城市居民';
  }
  for (const city of DESENSITIZE_MAP.city.newTier1) {
    if (text.includes(city)) return '新一线城市居民';
  }
  for (const city of DESENSITIZE_MAP.city.tier2) {
    if (text.includes(city)) return '二线城市居民';
  }
  // 检查省份等
  if (text.match(/县|乡|镇|村/)) return '县域/乡镇居民';
  return null;
}

function desensitizeJob(text) {
  const textLower = text.toLowerCase();
  for (const [pattern, label] of Object.entries(DESENSITIZE_MAP.job)) {
    const keywords = pattern.split('|');
    for (const kw of keywords) {
      if (textLower.includes(kw.toLowerCase())) return label;
    }
  }
  return null;
}

// ==================== 兴趣关键词提取 ====================
const INTEREST_PATTERNS = {
  hard_interests: [
    { pattern: /AI|人工智能|大模型|GPT|LLM|机器学习|深度学习/, tag: 'AI与大模型' },
    { pattern: /区块链|Web3|加密|比特币|以太坊|DeFi/, tag: '区块链与Web3' },
    { pattern: /芯片|半导体|GPU|算力/, tag: '半导体与芯片' },
    { pattern: /前端|后端|全栈|开发|编程|代码|框架/, tag: '软件开发' },
    { pattern: /投资|理财|基金|股票|A股|港股|美股/, tag: '投资理财' },
    { pattern: /房贷|房价|房产|买房|楼市/, tag: '房产与贷款' },
    { pattern: /创业|副业|自由职业|赚钱/, tag: '创业与副业' },
    { pattern: /教育|升学|考试|学区|育儿/, tag: '教育与育儿' },
    { pattern: /新能源|电车|电动车|充电/, tag: '新能源' },
    { pattern: /量化|期权|期货|交易/, tag: '量化与交易' },
    { pattern: /Rust|Go|Python|Java|TypeScript|React|Vue/, tag: '编程语言与框架' },
    { pattern: /出海|跨境|外贸|国际贸易/, tag: '出海与跨境' },
    { pattern: /SaaS|云计算|云原生|DevOps/, tag: '云计算与SaaS' },
    { pattern: /机器人|自动驾驶|无人驾驶/, tag: '机器人与自动驾驶' },
    { pattern: /生物|医药|基因|制药/, tag: '生物医药' },
    { pattern: /航天|航空|火箭|卫星|深空/, tag: '航天航空' },
    { pattern: /养老|养老金|退休|社保/, tag: '养老与社保' },
    { pattern: /健康|医疗|慢病|体检/, tag: '健康与医疗' },
    { pattern: /政策|两会|改革|宏观/, tag: '宏观政策' },
  ],
  soft_interests: [
    { pattern: /科幻|三体|流浪地球/, tag: '科幻文化' },
    { pattern: /追剧|电视剧|综艺|电影|影视/, tag: '影视娱乐' },
    { pattern: /游戏|电竞|手游/, tag: '游戏电竞' },
    { pattern: /NBA|CBA|篮球|足球|体育|赛事/, tag: '体育赛事' },
    { pattern: /跑步|健身|运动|马拉松|瑜伽/, tag: '运动健身' },
    { pattern: /旅游|旅行|出行|自驾/, tag: '旅行出行' },
    { pattern: /美食|烹饪|做饭|下厨/, tag: '美食烹饪' },
    { pattern: /摄影|拍照|相机/, tag: '摄影' },
    { pattern: /读书|阅读|书/, tag: '阅读' },
    { pattern: /播客|podcast/, tag: '播客' },
    { pattern: /咖啡|茶/, tag: '咖啡与茶' },
    { pattern: /八卦|明星|热搜|吃瓜/, tag: '娱乐八卦' },
    { pattern: /动漫|二次元|漫画/, tag: '动漫文化' },
    { pattern: /音乐|演唱会/, tag: '音乐' },
    { pattern: /宠物|猫|狗/, tag: '宠物' },
  ],
  core_risk_avoidance: [
    { pattern: /房贷|月供|还贷/, tag: '房贷压力管理' },
    { pattern: /裁员|失业|35岁|优化|被裁/, tag: '职业安全感' },
    { pattern: /孩子|小孩|教育|学区/, tag: '子女教育投入' },
    { pattern: /健康|体检|看病|医院/, tag: '个人与家庭健康' },
    { pattern: /理财|亏损|被骗|套路/, tag: '资产安全' },
    { pattern: /养老|退休金/, tag: '养老保障' },
    { pattern: /数据|隐私|安全/, tag: '数据与隐私安全' },
    { pattern: /通勤|油价|物价/, tag: '生活成本控制' },
  ],
};

function extractInterests(text) {
  const result = {
    hard_interests: [],
    soft_interests: [],
    core_risk_avoidance: [],
  };
  for (const [category, patterns] of Object.entries(INTEREST_PATTERNS)) {
    for (const { pattern, tag } of patterns) {
      if (pattern.test(text) && !result[category].includes(tag)) {
        result[category].push(tag);
      }
    }
  }
  return result;
}

// ==================== 搜索维度推断 ====================
function inferSearchDimensions(profile) {
  const dims = [];

  // 辅助函数：只有当 dims 中不存在包含 keyword 的条目时才添加
  function pushIfAbsent(keyword, dim) {
    if (!dims.some(d => d.includes(keyword))) dims.push(dim);
  }
  
  // 基于行业背景
  if (profile.industry_bg) {
    if (profile.industry_bg.includes('IT') || profile.industry_bg.includes('互联网')) {
      pushIfAbsent('AI', 'AI人工智能 大模型 科技产业 最新进展');
      pushIfAbsent('互联网', '互联网行业 科技公司 创业投资 动态');
    }
    if (profile.industry_bg.includes('金融')) {
      pushIfAbsent('金融', '金融市场 股市 基金 投资策略');
    }
    if (profile.industry_bg.includes('教育')) {
      pushIfAbsent('教育', '教育政策 教育改革 学校 招生');
    }
    if (profile.industry_bg.includes('医疗')) {
      pushIfAbsent('医疗', '医疗健康 医药 公立医院 改革');
    }
    if (profile.industry_bg.includes('公共服务')) {
      pushIfAbsent('时政', '时政要闻 政策走向 国际关系 经济数据');
    }
  }

  // 基于硬核兴趣（兼容新旧格式）
  const hardTags = interestTags(profile.hard_interests);
  for (const interest of hardTags) {
    if (interest.includes('AI') || interest.includes('大模型')) {
      pushIfAbsent('AI', 'AI人工智能 效率工具 大模型 应用');
    }
    if (interest.includes('半导体') || interest.includes('芯片')) {
      pushIfAbsent('半导体', '半导体 芯片 硬科技 产业');
    }
    if (interest.includes('投资') || interest.includes('理财')) {
      pushIfAbsent('投资', '投资理财 资产配置 经济趋势');
    }
    if (interest.includes('房产') || interest.includes('贷款')) {
      pushIfAbsent('房贷', '房贷利率 楼市政策 房价趋势');
    }
    if (interest.includes('教育') || interest.includes('育儿')) {
      pushIfAbsent('教育', '亲子教育 STEM教育 教育政策');
    }
    if (interest.includes('创业') || interest.includes('副业')) {
      pushIfAbsent('创业', '创业机会 副业 赚钱渠道 趋势');
    }
    if (interest.includes('新能源')) {
      pushIfAbsent('新能源', '新能源 电动车 充电桩 产业政策');
    }
    if (interest.includes('编程') || interest.includes('框架') || interest.includes('Rust') || interest.includes('Go') || interest.includes('Python')) {
      pushIfAbsent('编程', '软件开发 编程语言 技术框架 趋势');
    }
    if (interest.includes('养老') || interest.includes('社保')) {
      pushIfAbsent('养老', '养老政策 社保 退休金 调整');
    }
    if (interest.includes('宏观政策')) {
      pushIfAbsent('时政', '时政要闻 宏观经济 政策信号');
    }
    if (interest.includes('区块链') || interest.includes('Web3')) {
      pushIfAbsent('区块链', '区块链 Web3 加密货币 趋势');
    }
    if (interest.includes('出海') || interest.includes('跨境')) {
      pushIfAbsent('出海', '跨境电商 出海 外贸 趋势');
    }
    if (interest.includes('量化') || interest.includes('交易')) {
      pushIfAbsent('量化', '量化交易 期货期权 策略');
    }
    if (interest.includes('机器人') || interest.includes('自动驾驶')) {
      pushIfAbsent('机器人', '机器人 自动驾驶 智能制造');
    }
    if (interest.includes('生物') || interest.includes('医药')) {
      pushIfAbsent('生物', '生物医药 基因 制药 突破');
    }
    if (interest.includes('航天') || interest.includes('航空')) {
      pushIfAbsent('航天', '航天航空 火箭 卫星 深空探测');
    }
    if (interest.includes('云计算') || interest.includes('SaaS')) {
      pushIfAbsent('云计算', '云计算 SaaS 云原生 趋势');
    }
  }
  
  // 基于核心避险（兼容新旧格式）
  const riskTags = interestTags(profile.core_risk_avoidance);
  for (const risk of riskTags) {
    if (risk.includes('职业')) pushIfAbsent('就业', '就业市场 职场趋势 人才需求');
    if (risk.includes('房贷')) pushIfAbsent('房贷', '房贷利率 LPR 央行 政策');
    if (risk.includes('健康')) pushIfAbsent('健康', '健康科普 慢病管理 运动健康');
    if (risk.includes('生活成本')) pushIfAbsent('物价', '物价 通勤 油价 生活成本');
    if (risk.includes('子女教育')) pushIfAbsent('教育', '教育政策 亲子 升学');
    if (risk.includes('养老')) pushIfAbsent('养老', '养老政策 退休金 调整');
    if (risk.includes('资产')) pushIfAbsent('投资', '投资理财 防骗 资产配置');
  }

  // 基于轻松兴趣（取权重最高的前2个，兼容新旧格式）
  const softTags = interestTags(profile.soft_interests).slice(0, 2);
  for (const interest of softTags) {
    if (interest.includes('影视') || interest.includes('科幻')) {
      pushIfAbsent('影视', '热门剧集 电影推荐 影视资讯');
    } else if (interest.includes('体育') || interest.includes('赛事')) {
      pushIfAbsent('体育', '体育赛事 NBA 足球 比赛结果');
    } else if (interest.includes('游戏') || interest.includes('电竞')) {
      pushIfAbsent('游戏', '游戏新闻 热门游戏 电竞赛事');
    } else if (interest.includes('运动') || interest.includes('健身')) {
      pushIfAbsent('运动', '运动健身 跑步 马拉松 资讯');
    } else if (interest.includes('旅行') || interest.includes('旅游')) {
      pushIfAbsent('旅行', '旅游攻略 热门目的地 出行');
    } else if (interest.includes('美食') || interest.includes('烹饪')) {
      pushIfAbsent('美食', '美食推荐 烹饪 餐饮趋势');
    } else if (interest.includes('八卦') || interest.includes('娱乐')) {
      pushIfAbsent('娱乐', '娱乐八卦 明星 热搜');
    } else if (interest.includes('动漫') || interest.includes('二次元')) {
      pushIfAbsent('动漫', '动漫新番 二次元 漫画');
    } else if (interest.includes('音乐') || interest.includes('演唱会')) {
      pushIfAbsent('音乐', '音乐 演唱会 新歌推荐');
    } else if (interest.includes('摄影')) {
      pushIfAbsent('摄影', '摄影技巧 相机评测 摄影作品');
    } else if (interest.includes('宠物') || interest.includes('猫') || interest.includes('狗')) {
      pushIfAbsent('宠物', '宠物 猫狗 养护 萌宠');
    } else if (interest.includes('阅读') || interest.includes('播客')) {
      pushIfAbsent('阅读', '好书推荐 播客 知识分享');
    }
  }

  // 保底：通用热点
  if (dims.length < 3) {
    pushIfAbsent('热点', '国内外热点新闻 社会事件');
    pushIfAbsent('经济', '经济民生 消费趋势 最新政策');
  }

  // 去重并限制数量
  const unique = [...new Set(dims)];
  return unique.slice(0, 8);
}

// ==================== 推断语气风格 ====================
function inferTone(profile) {
  if (profile.industry_bg && profile.industry_bg.includes('IT')) {
    return '专业但亲和的智囊伙伴，像资深同事在茶水间聊天';
  }
  if (profile.industry_bg && profile.industry_bg.includes('金融')) {
    return '理性冷静的分析搭子，数据说话不画饼';
  }
  if (profile.industry_bg && profile.industry_bg.includes('公共服务')) {
    return '严谨客观但不打官腔，像靠谱的参谋';
  }
  if (profile.industry_bg && profile.industry_bg.includes('实干型')) {
    return '说人话不绕弯，直接给结论和建议';
  }
  if (profile.life_stage && profile.life_stage.includes('前辈')) {
    return '尊重但不装嫩，平实亲切，信息清晰';
  }
  if (profile.life_stage && (profile.life_stage.includes('学生') || profile.life_stage.includes('新锐'))) {
    return '像学长聊天，轻松但靠谱';
  }
  return '像朋友聊天一样自然，亲和但有干货';
}

// ==================== CLI 命令处理 ====================

// --get-profile: 获取当前画像
function cmdGetProfile() {
  const profile = loadJSON(PROFILE_FILE);
  if (profile) {
    console.log(JSON.stringify({ has_profile: true, profile }, null, 2));
  } else {
    console.log(JSON.stringify({ has_profile: false }));
  }
}

// --init-profile: 初始化画像
function cmdInitProfile(input) {
  if (!input) {
    console.error('❌ 需要提供 --input 参数');
    process.exit(1);
  }

  // 检查是否已有画像（合并模式：保留已有画像中对话积累的兴趣）
  const existingProfile = loadJSON(PROFILE_FILE);

  // 提取各维度信息
  const lifeStage = desensitizeAge(input) || '社会活跃期成员';
  const cityTier = desensitizeCity(input) || null;
  const industryBg = desensitizeJob(input) || null;
  const interests = extractInterests(input);

  const now = new Date().toISOString();

  // 将提取的兴趣转换为带权重格式
  function toWeighted(tags) {
    return tags.map(tag => ({ tag, weight: DEFAULT_WEIGHT, added_at: now, sentiment: 'positive' }));
  }

  // 构建画像
  const profile = {
    created_at: existingProfile ? existingProfile.created_at : now,
    updated_at: now,
    life_stage: lifeStage,
    industry_bg: industryBg || '综合背景',
    city_tier: cityTier || '城市居民',
    cognitive_style: '均衡型',
    notes: existingProfile ? (existingProfile.notes || '') : '',  // AI自由文本备忘
    core_risk_avoidance: interests.core_risk_avoidance.length > 0 
      ? toWeighted(interests.core_risk_avoidance) 
      : toWeighted(['生活成本控制', '职业安全感']),
    hard_interests: interests.hard_interests.length > 0 
      ? toWeighted(interests.hard_interests) 
      : toWeighted(['社会热点', '经济趋势']),
    soft_interests: interests.soft_interests.length > 0 
      ? toWeighted(interests.soft_interests) 
      : toWeighted(['影视娱乐']),
    tone: '',
    search_dimensions: [],
    raw_keywords: input.substring(0, 200),
  };

  // 如果已有画像，合并旧画像中存在但新提取中没有的兴趣（降权保留）
  if (existingProfile) {
    for (const field of ['hard_interests', 'soft_interests', 'core_risk_avoidance']) {
      const oldItems = migrateInterests(existingProfile[field] || []);
      for (const oldItem of oldItems) {
        if (!findSimilarInterest(profile[field], oldItem.tag)) {
          // 旧兴趣降权 50% 后保留
          profile[field].push({ ...oldItem, weight: oldItem.weight * 0.5 });
        }
      }
      profile[field] = decayAndPrune(profile[field]);
    }
  }

  // 推断搜索维度
  profile.search_dimensions = inferSearchDimensions(profile);
  // 推断语气
  profile.tone = inferTone(profile);

  // 尝试匹配模板画像
  const templates = loadJSON(TEMPLATES_FILE);
  if (templates && templates.templates) {
    let bestMatch = null;
    let bestScore = 0;
    for (const tmpl of templates.templates) {
      let score = 0;
      const inputLower = input.toLowerCase();
      for (const kw of (tmpl.match_keywords || [])) {
        if (inputLower.includes(kw.toLowerCase())) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = tmpl;
      }
    }
    if (bestMatch && bestScore >= 2) {
      // 合并模板的兴趣（不覆盖已提取的，模板兴趣权重稍低）
      for (const interest of (bestMatch.hard_interests || [])) {
        if (!findSimilarInterest(profile.hard_interests, interest)) {
          profile.hard_interests.push({ tag: interest, weight: 0.7, added_at: now, sentiment: 'positive' });
        }
      }
      for (const interest of (bestMatch.soft_interests || [])) {
        if (!findSimilarInterest(profile.soft_interests, interest)) {
          profile.soft_interests.push({ tag: interest, weight: 0.7, added_at: now, sentiment: 'positive' });
        }
      }
      if (bestMatch.cognitive_style) {
        profile.cognitive_style = bestMatch.cognitive_style;
      }
      // 裁剪并重新推断搜索维度
      profile.hard_interests = decayAndPrune(profile.hard_interests);
      profile.soft_interests = decayAndPrune(profile.soft_interests);
      profile.search_dimensions = inferSearchDimensions(profile);
    }
  }

  saveJSON(PROFILE_FILE, profile);
  console.log(JSON.stringify({
    status: 'ok',
    profile_hint: {
      life_stage: profile.life_stage,
      industry_bg: profile.industry_bg,
      city_tier: profile.city_tier,
      hard_interests: interestTags(profile.hard_interests),
      soft_interests: interestTags(profile.soft_interests),
      core_risk_avoidance: interestTags(profile.core_risk_avoidance),
      search_dimensions: profile.search_dimensions,
      tone: profile.tone,
      notes: profile.notes || '',
    },
    message: '画像已初始化。请基于以上 profile_hint 构建完整脱敏画像，用于后续搜索和改写。'
  }, null, 2));
}

// --update-profile: 更新画像（支持 add/remove/skeptical 操作 + notes）
function cmdUpdateProfile(addJson) {
  const profile = loadJSON(PROFILE_FILE);
  if (!profile) {
    console.error('❌ 本地画像不存在，请先执行 --init-profile');
    process.exit(1);
  }

  let addData;
  try {
    addData = JSON.parse(addJson);
  } catch (e) {
    console.error('❌ JSON 解析失败:', e.message);
    process.exit(1);
  }

  const { field, value, action, sentiment } = addData;
  const op = action || 'add';

  // 特殊处理 notes 字段
  if (field === 'notes') {
    if (op === 'append') {
      const current = profile.notes || '';
      const newNotes = (current ? current + '§' : '') + value;
      profile.notes = newNotes.substring(0, MAX_NOTES_CHARS);
    } else if (op === 'replace') {
      profile.notes = (value || '').substring(0, MAX_NOTES_CHARS);
    } else if (op === 'remove') {
      // 用子字符串匹配删除某条 note
      const parts = (profile.notes || '').split('§');
      profile.notes = parts.filter(p => !p.includes(value)).join('§');
    } else {
      // 默认 append
      const current = profile.notes || '';
      const newNotes = (current ? current + '§' : '') + value;
      profile.notes = newNotes.substring(0, MAX_NOTES_CHARS);
    }
    profile.updated_at = new Date().toISOString();
    saveJSON(PROFILE_FILE, profile);
    console.log(JSON.stringify({ status: 'ok', updated_field: 'notes', operation: op, notes_length: (profile.notes || '').length, max: MAX_NOTES_CHARS }, null, 2));
    return;
  }

  const arrayFields = ['hard_interests', 'soft_interests', 'core_risk_avoidance'];
  const stringFields = ['search_dimensions', 'life_stage', 'industry_bg', 'city_tier', 'cognitive_style', 'tone'];
  const validFields = [...arrayFields, ...stringFields];
  
  if (!validFields.includes(field)) {
    console.error(`❌ 不支持的字段: ${field}。支持: ${validFields.join(', ')}, notes`);
    process.exit(1);
  }

  let result = { action: op };

  if (arrayFields.includes(field)) {
    profile[field] = migrateInterests(profile[field]);

    if (op === 'remove') {
      const res = removeInterest(profile[field], value);
      profile[field] = res.interests;
      result.action = res.action;
    } else if (op === 'skeptical') {
      // 标记为怀疑态度：不删除但降权并标记 sentiment
      const target = findSimilarInterest(profile[field], value);
      if (target) {
        target.sentiment = 'skeptical';
        target.weight = Math.max(target.weight * 0.5, MIN_WEIGHT_THRESHOLD);
        result.action = 'marked_skeptical';
      } else {
        result.action = 'not_found';
      }
    } else {
      // add（支持 sentiment 参数）
      const res = addInterest(profile[field], value, sentiment);
      profile[field] = res.interests;
      result.action = res.action;
    }
  } else if (field === 'search_dimensions') {
    if (op === 'remove') {
      profile.search_dimensions = (profile.search_dimensions || []).filter(d => !d.includes(value));
    } else if (!profile.search_dimensions.includes(value)) {
      profile.search_dimensions.push(value);
    }
  } else {
    profile[field] = value;
  }

  profile.updated_at = new Date().toISOString();
  
  // 对所有兴趣字段执行衰减裁剪
  for (const f of arrayFields) {
    if (Array.isArray(profile[f]) && profile[f].length > 0 && typeof profile[f][0] === 'object') {
      profile[f] = decayAndPrune(profile[f]);
    }
  }

  // 连锁更新
  if ([...arrayFields, 'industry_bg', 'life_stage'].includes(field)) {
    profile.search_dimensions = inferSearchDimensions(profile);
    profile.tone = inferTone(profile);
  }

  saveJSON(PROFILE_FILE, profile);
  console.log(JSON.stringify({ 
    status: 'ok', 
    updated_field: field, 
    value, 
    operation: result.action,
    interests_count: {
      hard: (profile.hard_interests || []).length,
      soft: (profile.soft_interests || []).length,
      risk: (profile.core_risk_avoidance || []).length,
    },
  }, null, 2));
}

// --save-news: 保存新闻数据
function cmdSaveNews(dataJson) {
  let data;
  try {
    data = JSON.parse(dataJson);
  } catch (e) {
    console.error('❌ JSON 解析失败:', e.message);
    process.exit(1);
  }

  const today = getTodayStr();
  
  // 加载现有新闻存档
  let archive = loadJSON(NEWS_FILE) || { days: {} };
  
  if (!archive.days[today]) {
    archive.days[today] = { batches: [] };
  }

  // 添加新批次
  archive.days[today].batches.push({
    timestamp: new Date().toISOString(),
    news: data.news || [],
  });

  // 清理超过 7 天的旧数据
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  for (const dateKey of Object.keys(archive.days)) {
    if (new Date(dateKey) < sevenDaysAgo) {
      delete archive.days[dateKey];
    }
  }

  saveJSON(NEWS_FILE, archive);
  
  // 同时保存到历史目录
  const historyFile = path.join(HISTORY_DIR, today + '.json');
  saveJSON(historyFile, archive.days[today]);

  // 清理过期的历史文件
  try {
    const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const fileDate = new Date(f.replace('.json', ''));
      if (fileDate < sevenDaysAgo) {
        fs.unlinkSync(path.join(HISTORY_DIR, f));
      }
    }
  } catch (e) { /* ignore */ }

  console.log(JSON.stringify({
    status: 'ok',
    date: today,
    batch_count: archive.days[today].batches.length,
    news_count: (data.news || []).length,
  }));
}

// --get-shown-news: 获取已展示的新闻标题
function cmdGetShownNews() {
  const shown = loadJSON(SHOWN_FILE) || { titles: [], last_updated: null };
  console.log(JSON.stringify(shown, null, 2));
}

// --mark-shown: 标记新闻为已展示
function cmdMarkShown(titlesJson) {
  let titles;
  try {
    titles = JSON.parse(titlesJson);
  } catch (e) {
    console.error('❌ JSON 解析失败:', e.message);
    process.exit(1);
  }

  let shown = loadJSON(SHOWN_FILE) || { titles: [], last_updated: null };
  
  // 清理超过 3 天的记录（避免无限增长）
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  if (shown.last_updated && shown.last_updated < threeDaysAgo) {
    shown.titles = [];
  }

  for (const title of titles) {
    if (!shown.titles.includes(title)) {
      shown.titles.push(title);
    }
  }
  shown.last_updated = new Date().toISOString();

  saveJSON(SHOWN_FILE, shown);
  console.log(JSON.stringify({ status: 'ok', total_shown: shown.titles.length }));
}

// --debug-profile: 查看完整画像（调试用）
function cmdDebugProfile() {
  const profile = loadJSON(PROFILE_FILE);
  if (!profile) {
    console.log('⚠️ 本地画像不存在');
    return;
  }
  console.log('=== 用户画像（调试） ===');
  console.log(JSON.stringify(profile, null, 2));
}

// --reset-profile: 重置画像
function cmdResetProfile() {
  if (fs.existsSync(PROFILE_FILE)) {
    fs.unlinkSync(PROFILE_FILE);
  }
  if (fs.existsSync(SHOWN_FILE)) {
    fs.unlinkSync(SHOWN_FILE);
  }
  console.log('✅ 画像已重置');
}

// --get-history: 获取历史新闻
function cmdGetHistory(dateStr) {
  if (dateStr) {
    const historyFile = path.join(HISTORY_DIR, dateStr + '.json');
    const data = loadJSON(historyFile);
    if (data) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(JSON.stringify({ error: `未找到 ${dateStr} 的历史数据` }));
    }
  } else {
    // 列出所有历史日期
    try {
      const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'));
      const dates = files.map(f => f.replace('.json', '')).sort().reverse();
      console.log(JSON.stringify({ dates }));
    } catch (e) {
      console.log(JSON.stringify({ dates: [] }));
    }
  }
}

// --daily-update: 每日画像更新（供晚12点定时任务调用）
// 功能：
//   1. 对所有兴趣执行时间衰减
//   2. 分析当天已展示的新闻，统计各维度的消费频次
//   3. 对高消费维度对应的兴趣执行 boost
//   4. 清理过期的 shown 记录
//   5. 输出更新摘要供 AI 参考
function cmdDailyUpdate() {
  const profile = loadJSON(PROFILE_FILE);
  if (!profile) {
    console.log(JSON.stringify({ status: 'skip', reason: '画像不存在，跳过每日更新' }));
    return;
  }

  const today = getTodayStr();
  const updateSummary = { decayed: [], boosted: [], removed: [], merged: [], date: today };

  // --- 1. 对所有兴趣字段执行衰减 ---
  const arrayFields = ['hard_interests', 'soft_interests', 'core_risk_avoidance'];
  for (const field of arrayFields) {
    const before = migrateInterests(profile[field] || []);
    const after = decayAndPrune(before);
    
    const afterTags = new Set(after.map(i => i.tag));
    for (const item of before) {
      if (!afterTags.has(item.tag)) {
        updateSummary.removed.push(item.tag);
      }
    }
    
    for (const item of after) {
      const oldItem = before.find(b => b.tag === item.tag);
      if (oldItem && item.weight < oldItem.weight) {
        updateSummary.decayed.push({ tag: item.tag, from: oldItem.weight, to: item.weight });
      }
    }
    
    profile[field] = after;
  }

  // --- 1.5 兴趣合并：找出可以合并的低权重相似兴趣对，输出建议供AI执行 ---
  const normForMerge = s => s.replace(/与|和|\s/g, '').toLowerCase();
  for (const field of arrayFields) {
    const items = profile[field];
    if (items.length < 2) continue;
    const lowItems = items.filter(i => i.weight < 0.6).sort((a, b) => a.weight - b.weight);
    for (let i = 0; i < lowItems.length; i++) {
      for (let j = i + 1; j < lowItems.length; j++) {
        const a = normForMerge(lowItems[i].tag);
        const b = normForMerge(lowItems[j].tag);
        if (a.includes(b) || b.includes(a) || (a.length >= 4 && b.length >= 4 && a.substring(0, 2) === b.substring(0, 2))) {
          updateSummary.merged.push({
            from: [lowItems[i].tag, lowItems[j].tag],
            suggestion: `建议合并为一条：保留"${lowItems[i].weight >= lowItems[j].weight ? lowItems[i].tag : lowItems[j].tag}"，删除另一条`,
          });
        }
      }
    }
  }

  // --- 2. 分析当天新闻消费行为 ---
  const shown = loadJSON(SHOWN_FILE) || { titles: [], last_updated: null };
  const todayNews = loadJSON(path.join(HISTORY_DIR, today + '.json'));

  // 统计当天被展示的新闻的维度分布
  const dimensionCounts = {};
  if (todayNews && todayNews.batches) {
    for (const batch of todayNews.batches) {
      for (const news of (batch.news || [])) {
        if (news.dimension) {
          dimensionCounts[news.dimension] = (dimensionCounts[news.dimension] || 0) + 1;
        }
      }
    }
  }

  // --- 3. 对高消费维度对应的兴趣执行 boost ---
  // 如果某个维度当天被消费了 ≥2 条新闻，对相关兴趣 boost
  for (const [dim, count] of Object.entries(dimensionCounts)) {
    if (count >= 2) {
      // 将维度拆成关键词集合（按空格分割）
      const dimWords = dim.split(/[\s]+/).filter(w => w.length >= 2);
      
      for (const field of arrayFields) {
        for (const item of profile[field]) {
          // 将兴趣标签也拆成词（去掉连接词）
          const tagWords = item.tag.replace(/[与和]/g, ' ').split(/[\s]+/).filter(w => w.length >= 2);
          
          // 检查兴趣标签的任意词是否出现在维度关键词中
          const matched = tagWords.some(tw => 
            dimWords.some(dw => dw.includes(tw) || tw.includes(dw))
          );
          
          if (matched) {
            const oldWeight = item.weight;
            item.weight = Math.min(item.weight + 0.15, 2.0); // 日度 boost 较小，0.15
            item.added_at = new Date().toISOString();
            if (item.weight > oldWeight) {
              updateSummary.boosted.push({ tag: item.tag, from: oldWeight, to: item.weight });
            }
          }
        }
      }
    }
  }

  // --- 4. 重推搜索维度和语气 ---
  profile.search_dimensions = inferSearchDimensions(profile);
  profile.tone = inferTone(profile);
  profile.updated_at = new Date().toISOString();

  // --- 5. 清理过期的 shown 记录 ---
  if (shown.titles.length > 0) {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    if (shown.last_updated && shown.last_updated < threeDaysAgo) {
      shown.titles = [];
      shown.last_updated = new Date().toISOString();
      saveJSON(SHOWN_FILE, shown);
    }
  }

  saveJSON(PROFILE_FILE, profile);

  // 输出摘要
  console.log(JSON.stringify({
    status: 'ok',
    date: today,
    summary: {
      decayed_count: updateSummary.decayed.length,
      boosted_count: updateSummary.boosted.length,
      removed_count: updateSummary.removed.length,
      removed_tags: updateSummary.removed,
      boosted_tags: updateSummary.boosted.map(b => b.tag),
      merge_suggestions: updateSummary.merged,
      today_news_dimensions: dimensionCounts,
      total_interests: {
        hard: (profile.hard_interests || []).length,
        soft: (profile.soft_interests || []).length,
        risk: (profile.core_risk_avoidance || []).length,
      },
      notes: profile.notes || '',
      notes_length: (profile.notes || '').length,
    },
    search_dimensions: profile.search_dimensions,
    hint: '请根据以上统计：1）如果 removed 不为空，提示"某某兴趣因长期未提及已自动清理"；2）如果 merge_suggestions 不为空，请执行合并操作（--update-profile 先 remove 再 add）；3）如果你观察到正则无法覆盖的用户偏好，写入 notes（--update-profile --add \'{"field":"notes","value":"观察内容"}\'）。',
  }, null, 2));
}

// ==================== 主入口 ====================
function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printHelp();
    return;
  }

  // --get-profile
  if (args.includes('--get-profile')) {
    cmdGetProfile();
    return;
  }

  // --init-profile --input "..."
  if (args.includes('--init-profile')) {
    const idx = args.indexOf('--input');
    const input = idx >= 0 ? args[idx + 1] : null;
    cmdInitProfile(input);
    return;
  }

  // --daily-update
  if (args.includes('--daily-update')) {
    cmdDailyUpdate();
    return;
  }

  // --update-profile --add '{"field":"...","value":"..."}'
  if (args.includes('--update-profile')) {
    const idx = args.indexOf('--add');
    const addJson = idx >= 0 ? args[idx + 1] : null;
    if (!addJson) {
      console.error('❌ 需要提供 --add 参数');
      process.exit(1);
    }
    cmdUpdateProfile(addJson);
    return;
  }

  // --save-news --data '...'
  if (args.includes('--save-news')) {
    const idx = args.indexOf('--data');
    const dataJson = idx >= 0 ? args[idx + 1] : null;
    if (!dataJson) {
      console.error('❌ 需要提供 --data 参数');
      process.exit(1);
    }
    cmdSaveNews(dataJson);
    return;
  }

  // --get-shown-news
  if (args.includes('--get-shown-news')) {
    cmdGetShownNews();
    return;
  }

  // --mark-shown --titles '["标题1","标题2"]'
  if (args.includes('--mark-shown')) {
    const idx = args.indexOf('--titles');
    const titlesJson = idx >= 0 ? args[idx + 1] : null;
    if (!titlesJson) {
      console.error('❌ 需要提供 --titles 参数');
      process.exit(1);
    }
    cmdMarkShown(titlesJson);
    return;
  }

  // --debug-profile
  if (args.includes('--debug-profile')) {
    cmdDebugProfile();
    return;
  }

  // --reset-profile
  if (args.includes('--reset-profile')) {
    cmdResetProfile();
    return;
  }

  // --get-history [date]
  if (args.includes('--get-history')) {
    const idx = args.indexOf('--get-history');
    const dateStr = args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : null;
    cmdGetHistory(dateStr);
    return;
  }

  // 未知命令
  console.error(`❌ 未知命令: ${args.join(' ')}`);
  printHelp();
  process.exit(1);
}

function printHelp() {
  console.log(`
腾讯新闻搭子 (News Buddy) — 画像与数据管理

命令:
  --get-profile                         查看当前画像
  --init-profile --input "描述"         初始化画像（基于用户自然语言，已有画像时合并保留）
  --daily-update                        每日画像更新（衰减+boost消费维度，供定时任务调用）
  --update-profile --add '{"field":"hard_interests","value":"量化交易"}'
                                        添加兴趣（近义词自动合并提权）
  --update-profile --add '{"field":"hard_interests","value":"区块链","action":"remove"}'
                                        移除兴趣（支持模糊匹配）
  --save-news --data '<JSON>'           保存搜索到的新闻数据
  --get-shown-news                      获取已展示的新闻标题
  --mark-shown --titles '["标题1"]'     标记新闻为已展示
  --get-history [date]                  查看历史新闻（不指定日期则列出所有）
  --debug-profile                       查看完整画像（调试）
  --reset-profile                       重置画像和展示记录

画像更新特性:
  - 兴趣带权重（0~2.0）和时间戳，支持时间衰减（半衰期${DECAY_HALF_LIFE_DAYS}天）
  - 权重低于${MIN_WEIGHT_THRESHOLD}的兴趣自动清理
  - 每个类别最多保留${MAX_INTERESTS_PER_CATEGORY}个兴趣
  - 近义词自动检测合并（如"AI与大模型"和"大模型技术"不会重复添加）
  - 更新兴趣/行业/人生阶段时自动重推搜索维度和语气风格

示例:
  node news-buddy.cjs --init-profile --input "我是深圳的前端开发，有房贷，关注AI"
  node news-buddy.cjs --get-profile
  node news-buddy.cjs --update-profile --add '{"field":"hard_interests","value":"Rust编程"}'
  node news-buddy.cjs --update-profile --add '{"field":"hard_interests","value":"Rust","action":"skeptical"}'
  node news-buddy.cjs --update-profile --add '{"field":"hard_interests","value":"区块链","action":"remove"}'
  node news-buddy.cjs --update-profile --add '{"field":"notes","value":"用户偏好深度长文"}'
  node news-buddy.cjs --daily-update
  node news-buddy.cjs --reset-profile
  `);
}

main();
