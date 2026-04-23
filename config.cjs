// config.cjs — AI 新闻搭子 配置管理
// v2.0: 简化配置，搜索由 AI 的 web_search 承担，不再需要独立的 LLM API 配置
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '.news-buddy-config.json');

const DEFAULT_CONFIG = {
  // 新闻保留天数
  NEWS_RETENTION_DAYS: 7,
  // 每次推荐新闻数量
  NEWS_COUNT: 8,
  // 搜索时效（天）
  SEARCH_RECENCY_DAYS: 7,
  // 画像自动清理（天）
  PROFILE_MAX_AGE_DAYS: 90,
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const saved = JSON.parse(raw);
      return { ...DEFAULT_CONFIG, ...saved };
    }
  } catch (e) { /* ignore */ }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

function updateConfig(key, value) {
  const config = loadConfig();
  config[key] = value;
  saveConfig(config);
  return config;
}

function checkConfig() {
  const config = loadConfig();
  // v2.0: 无必需配置项，所有配置都有默认值
  return { config, missing: [], isComplete: true };
}

module.exports = { loadConfig, saveConfig, updateConfig, checkConfig, DEFAULT_CONFIG };
