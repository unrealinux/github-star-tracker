/**
 * P3: 通用数据源插件
 * 每个源实现 { label, unit, placeholder, fetch(key) → { value, label?, url?, unit? } | null }
 * 新增源只需在此注册。
 */

const TIMEOUT_MS = 10_000;

async function getJson(url, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "github-star-tracker", ...headers },
      signal: ctrl.signal,
    });
    if (res.status === 404) return null; // 确实不存在
    if (res.status === 429) throw new Error("数据源限流（429），请稍后重试");
    if (!res.ok) throw new Error(`数据源返回 HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error("数据源请求超时");
    if (e.message?.startsWith("数据源")) throw e;
    throw new Error(`无法连接数据源：${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

export const SOURCES = {
  npm: {
    label: "npm 周下载量",
    unit: "次/周",
    placeholder: "包名，如 react",
    async fetch(key) {
      const d = await getJson(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(key)}`);
      if (!d) return null;
      if (typeof d.downloads !== "number") return null;
      return { value: d.downloads, label: key, url: `https://www.npmjs.com/package/${key}`, unit: "次/周" };
    },
  },

  pypi: {
    label: "PyPI 周下载量",
    unit: "次/周",
    placeholder: "包名，如 requests",
    async fetch(key) {
      const d = await getJson(`https://pypistats.org/api/packages/${encodeURIComponent(key)}/recent`);
      if (!d) return null;
      const v = d?.data?.last_week;
      if (typeof v !== "number") return null;
      return { value: v, label: key, url: `https://pypi.org/project/${key}/`, unit: "次/周" };
    },
  },

  dockerhub: {
    label: "Docker Hub 拉取量",
    unit: "次",
    placeholder: "namespace/repo，如 library/nginx",
    async fetch(key) {
      const d = await getJson(`https://hub.docker.com/v2/repositories/${key}/`);
      if (!d) return null;
      if (typeof d.pull_count !== "number") return null;
      return {
        value: d.pull_count,
        label: d.name || key,
        url: `https://hub.docker.com/r/${key}`,
        unit: "次",
      };
    },
  },

  crates: {
    label: "crates.io 下载量",
    unit: "次",
    placeholder: "crate 名，如 serde",
    async fetch(key) {
      const d = await getJson(`https://crates.io/api/v1/crates/${encodeURIComponent(key)}`);
      if (!d) return null;
      const v = d?.crate?.downloads;
      if (typeof v !== "number") return null;
      return { value: v, label: key, url: `https://crates.io/crates/${key}`, unit: "次" };
    },
  },

  hackernews: {
    label: "Hacker News 提及数",
    unit: "篇",
    placeholder: "关键词，如 rust",
    async fetch(key) {
      const d = await getJson(
        `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(key)}&tags=story&hitsPerPage=0`,
      );
      if (!d || typeof d.nbHits !== "number") return null;
      return {
        value: d.nbHits,
        label: `HN: ${key}`,
        url: `https://hn.algolia.com/?q=${encodeURIComponent(key)}`,
        unit: "篇",
      };
    },
  },

  homebrew: {
    label: "Homebrew 30天安装量",
    unit: "次/30天",
    placeholder: "formula 名，如 wget",
    async fetch(key) {
      const d = await getJson(`https://formulae.brew.sh/api/formula/${encodeURIComponent(key)}.json`);
      if (!d) return null;
      const v = d?.analytics?.install_on_request?.["30d"]?.[key] ?? d?.analytics?.install?.["30d"]?.[key];
      if (typeof v !== "number") return null;
      return {
        value: v,
        label: d.name || key,
        url: `https://formulae.brew.sh/formula/${key}`,
        unit: "次/30天",
      };
    },
  },

  rubygems: {
    label: "RubyGems 下载量",
    unit: "次",
    placeholder: "gem 名，如 rails",
    async fetch(key) {
      const d = await getJson(`https://rubygems.org/api/v1/gems/${encodeURIComponent(key)}.json`);
      if (!d || typeof d.downloads !== "number") return null;
      return {
        value: d.downloads,
        label: d.name || key,
        url: `https://rubygems.org/gems/${key}`,
        unit: "次",
      };
    },
  },

  nuget: {
    label: "NuGet 下载量",
    unit: "次",
    placeholder: "包名，如 Newtonsoft.Json",
    async fetch(key) {
      const d = await getJson(
        `https://azuresearch-usnc.nuget.org/query?q=packageid:${encodeURIComponent(key)}&prerelease=false`,
      );
      const list = Array.isArray(d?.data) ? d.data : [];
      const pkg = list.find((x) => String(x.id).toLowerCase() === String(key).toLowerCase()) || list[0];
      if (!pkg || typeof pkg.totalDownloads !== "number") return null;
      return {
        value: pkg.totalDownloads,
        label: pkg.id,
        url: `https://www.nuget.org/packages/${pkg.id}`,
        unit: "次",
      };
    },
  },

  openvsx: {
    label: "Open VSX 安装量",
    unit: "次",
    placeholder: "namespace/extension，如 vscodevim/vim",
    async fetch(key) {
      const [ns, ext] = String(key).split("/");
      if (!ns || !ext) return null;
      const d = await getJson(
        `https://open-vsx.org/api/${encodeURIComponent(ns)}/${encodeURIComponent(ext)}`,
      );
      if (!d || typeof d.downloadCount !== "number") return null;
      return {
        value: d.downloadCount,
        label: d.displayName || `${ns}/${ext}`,
        url: `https://open-vsx.org/extension/${ns}/${ext}`,
        unit: "次",
      };
    },
  },
};

export const SOURCE_LIST = Object.entries(SOURCES).map(([key, s]) => ({
  key,
  label: s.label,
  unit: s.unit,
  placeholder: s.placeholder,
}));

/** 抓取某个源的值 */
export async function fetchSource(sourceKey, key) {
  const src = SOURCES[sourceKey];
  if (!src) throw new Error(`未知数据源: ${sourceKey}`);
  return src.fetch(String(key).trim());
}
