const BASE = "https://api.github.com";

export async function searchTopRepos({ minStars, token, maxPages = 3, perPage = 100 }) {
  const q = encodeURIComponent(`stars:>=${minStars}`);
  const items = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = `${BASE}/search/repositories?q=${q}&sort=stars&order=desc&per_page=${perPage}&page=${page}`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "github-star-tracker",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

    if (res.status === 403 || res.status === 429) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`GitHub 限流（${res.status}）: ${body.message || "rate limit exceeded"}`);
    }
    if (!res.ok) {
      throw new Error(`GitHub API 错误（${res.status}）`);
    }

    const data = await res.json();
    if (!data.items || data.items.length === 0) break;

    for (const it of data.items) {
      items.push({
        full_name: it.full_name,
        owner: (it.owner && it.owner.login) || null,
        name: it.name,
        url: it.html_url,
        description: it.description,
        language: it.language,
        homepage: it.homepage,
        stars: it.stargazers_count,
        gh_created_at: it.created_at,
      });
    }

    if (data.items.length < perPage) break;
  }

  return items;
}
