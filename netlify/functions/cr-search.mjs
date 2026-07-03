// Netlify Function: пошук турнірів гравця на chess-results.com
// Виклик: /.netlify/functions/cr-search?last=Іваненко&first=Іван
//
// Сайт chess-results.com — старий ASP.NET WebForms (POST + __VIEWSTATE).
// Тому логіка в 3 кроки:
//  1) GET сторінки пошуку -> дістаємо __VIEWSTATE / __VIEWSTATEGENERATOR /
//     __EVENTVALIDATION + cookie сесії, а також динамічно знаходимо
//     реальні name="" полів "Прізвище" / "Ім'я" та кнопки пошуку
//     (шукаємо по мітці в HTML, а не по захардкодженому імені).
//  2) POST з тими самими hidden-полями + вписаним прізвищем/ім'ям.
//  3) Парсимо HTML-таблицю результатів (рядки з датою і назвою турніру).

const BASE = "https://chess-results.com/SpielerSuche.aspx?lan=1";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function extractHidden(html) {
  const hidden = {};
  const re = /<input\b[^>]*type=["']hidden["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const name = /name=["']([^"']+)["']/i.exec(tag)?.[1];
    const value = /value=["']([^"']*)["']/i.exec(tag)?.[1] || "";
    if (name) hidden[name] = value;
  }
  return hidden;
}

// Знаходить name="" текстового інпуту, що йде найближче ПІСЛЯ заданої мітки
function findInputNear(html, labelVariants) {
  for (const label of labelVariants) {
    const idx = html.indexOf(label);
    if (idx === -1) continue;
    const window = html.slice(idx, idx + 600);
    const inputMatch = /<input\b[^>]*>/i.exec(window);
    if (inputMatch) {
      const name = /name=["']([^"']+)["']/i.exec(inputMatch[0])?.[1];
      if (name) return name;
    }
  }
  return null;
}

// Діагностика: перелік УСІХ видимих (не hidden) input/select полів
// разом із текстом, що йде безпосередньо ПЕРЕД ними (підказка-мітка)
function listFieldCandidates(html) {
  const tagRegex = /<(input|select)\b[^>]*>/gi;
  const results = [];
  let m;
  while ((m = tagRegex.exec(html))) {
    const tag = m[0];
    const type = /type=["']([^"']+)["']/i.exec(tag)?.[1] || (m[1].toLowerCase() === "select" ? "select" : "text");
    if (type === "hidden") continue;
    const name = /name=["']([^"']+)["']/i.exec(tag)?.[1] || null;
    if (!name) continue;

    const before = html.slice(Math.max(0, m.index - 250), m.index);
    const labelGuess = before
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(-70);

    results.push({ tagName: m[1], name, type, labelGuess });
  }
  return results;
}

// Відомі точні імена полів на chess-results.com (визначено емпірично)
const KNOWN_LAST_NAME_FIELD = "ctl00$P1$txt_nachname";
const KNOWN_FIRST_NAME_FIELD = "ctl00$P1$txt_vorname";

function extractSelectedValue(html, selectName) {
  const selectRe = new RegExp(`<select[^>]*name=["']${selectName.replace(/\$/g, "\\$")}["'][^>]*>([\\s\\S]*?)</select>`, "i");
  const selectMatch = selectRe.exec(html);
  if (!selectMatch) return null;
  const body = selectMatch[1];
  const selectedOpt = /<option\b[^>]*value=["']([^"']*)["'][^>]*selected[^>]*>/i.exec(body);
  if (selectedOpt) return selectedOpt[1];
  const firstOpt = /<option\b[^>]*value=["']([^"']*)["'][^>]*>/i.exec(body);
  return firstOpt ? firstOpt[1] : null;
}
function findSubmitButton(html) {
  // ASP.NET LinkButton -> викликає __doPostBack('ID','') замість справжнього submit.
  // Шукаємо onclick="...__doPostBack('...Search...','')" або input[type=submit]
  const submitInput = /<input\b[^>]*type=["'](submit|image)["'][^>]*>/i.exec(html);
  if (submitInput) {
    const name = /name=["']([^"']+)["']/i.exec(submitInput[0])?.[1];
    const value = /value=["']([^"']*)["']/i.exec(submitInput[0])?.[1] || "Search";
    if (name) return { name, value };
  }
  const postback = /__doPostBack\('([^']*[Ss]earch[^']*)','?'?\)/.exec(html);
  if (postback) return { eventTarget: postback[1] };
  return null;
}

function parseCookies(setCookieHeader) {
  if (!setCookieHeader) return "";
  // setCookieHeader може містити декілька cookie через кому (спрощено беремо перші пари)
  return setCookieHeader
    .split(/,(?=[^ ]+?=)/)
    .map((c) => c.split(";")[0])
    .join("; ");
}

function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8217;/g, "’");
}

function parseResultsTable(html) {
  // Беремо найбільшу <table>...</table> у відповіді як таблицю результатів
  const tables = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map((m) => m[0]);
  if (!tables.length) return { rows: [], rawSnippet: html.slice(0, 3000) };

  tables.sort((a, b) => b.length - a.length);
  const table = tables[0];

  const rowsHtml = [...table.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
  const rows = [];

  for (const rowHtml of rowsHtml) {
    const cells = [...rowHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
      decodeEntities(m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    );
    if (cells.length < 10) continue; // рядок-заголовок або службовий рядок пропускаємо

    // Реальна структура колонок chess-results.com (визначено емпірично):
    // 0 Ім'я, 1 Рейтинг, 2 Fide-ID, 3 Клуб, 4 Федерація, 5 Турнір,
    // 6 Дата (YYYY/MM/DD), 7 Місце, 8 Очки, 9 К-сть учасників
    const [name, rtg, fideId, club, fed, tournament, dateRaw, place, points, participants] = cells;

    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(dateRaw || "")) continue; // не рядок турніру

    const linkMatch = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/i.exec(rowHtml);

    rows.push({
      name,
      rtg,
      fideId,
      club,
      fed,
      tournamentName: tournament,
      date: dateRaw, // формат YYYY/MM/DD
      place,
      points,
      participants,
      tournamentLink: linkMatch ? linkMatch[1] : null,
    });
  }

  return { rows, rawSnippet: rows.length ? null : html.slice(0, 3000) };
}

export default async (req) => {
  const url = new URL(req.url);
  const lastName = url.searchParams.get("last") || "";
  const firstName = url.searchParams.get("first") || "";
  const debug = url.searchParams.get("debug") === "1";

  if (!lastName) {
    return new Response(JSON.stringify({ error: "Параметр last (прізвище) обов'язковий" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  try {
    // Крок 1: GET форми
    const getRes = await fetch(BASE, { headers: { "User-Agent": UA } });
    const getHtml = await getRes.text();
    const cookie = parseCookies(getRes.headers.get("set-cookie"));

    const hidden = extractHidden(getHtml);
    const lastNameField = KNOWN_LAST_NAME_FIELD;
    const firstNameField = KNOWN_FIRST_NAME_FIELD;
    const submitInfo = findSubmitButton(getHtml);
    const sortValue = extractSelectedValue(getHtml, "ctl00$P1$combo_Sort");
    const rowsValue = extractSelectedValue(getHtml, "ctl00$P1$combo_anzahl_zeilen");

    if (!lastNameField || !submitInfo) {
      return new Response(
        JSON.stringify(
          {
            error: "Не вдалося автоматично визначити поля форми",
            lastNameField,
            firstNameField,
            submitInfo,
            hiddenFieldsFound: Object.keys(hidden),
            fieldCandidates: listFieldCandidates(getHtml),
          },
          null,
          2
        ),
        { status: 500, headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    // Крок 2: POST пошуку
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(hidden)) body.set(k, v);
    body.set(lastNameField, lastName);
    if (firstNameField) body.set(firstNameField, firstName);
    if (sortValue !== null) body.set("ctl00$P1$combo_Sort", sortValue);
    if (rowsValue !== null) body.set("ctl00$P1$combo_anzahl_zeilen", rowsValue);

    if (submitInfo.name) {
      body.set(submitInfo.name, submitInfo.value);
    } else if (submitInfo.eventTarget) {
      body.set("__EVENTTARGET", submitInfo.eventTarget);
      body.set("__EVENTARGUMENT", "");
    }

    const postRes = await fetch(getRes.url, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
      },
      body: body.toString(),
    });
    const postHtml = await postRes.text();

    const parsed = parseResultsTable(postHtml);

    const responsePayload = {
      lastName,
      firstName,
      resultCount: parsed.rows.length,
      results: parsed.rows,
    };
    if (debug || !parsed.rows.length) {
      responsePayload.debug = {
        lastNameField,
        firstNameField,
        submitInfo,
        postUrl: getRes.url,
        rawSnippet: parsed.rawSnippet,
      };
    }

    return new Response(JSON.stringify(responsePayload, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
};
