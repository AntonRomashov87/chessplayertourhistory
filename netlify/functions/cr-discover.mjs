// Тимчасова діагностична функція.
// Ціль: побачити РЕАЛЬНІ імена полів форми пошуку гравця на chess-results.com,
// бо це старий ASP.NET WebForms сайт (POST + __VIEWSTATE), і без цього
// неможливо коректно зібрати запит пошуку.
//
// Викликати: /.netlify/functions/cr-discover
// Повертає JSON зі списком усіх <input>/<select> на сторінці пошуку.

export default async () => {
  try {
    const res = await fetch("https://s1.chess-results.com/SpielerSuche.aspx?lan=1", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });

    const html = await res.text();

    // Витягуємо всі <input ...> та <select ...> теги разом з атрибутами
    const inputRegex = /<input\b[^>]*>/gi;
    const selectRegex = /<select\b[^>]*>[\s\S]*?<\/select>/gi;

    const inputs = (html.match(inputRegex) || []).map((tag) => {
      const name = /name=["']([^"']+)["']/i.exec(tag)?.[1] || null;
      const id = /id=["']([^"']+)["']/i.exec(tag)?.[1] || null;
      const type = /type=["']([^"']+)["']/i.exec(tag)?.[1] || "text";
      const value = /value=["']([^"']*)["']/i.exec(tag)?.[1] || "";
      return { tag: "input", name, id, type, value: value.slice(0, 60) };
    });

    const selects = (html.match(selectRegex) || []).map((tag) => {
      const name = /name=["']([^"']+)["']/i.exec(tag)?.[1] || null;
      const id = /id=["']([^"']+)["']/i.exec(tag)?.[1] || null;
      const optionMatches = [...tag.matchAll(/<option[^>]*value=["']([^"']*)["'][^>]*>([^<]*)</gi)];
      const options = optionMatches.slice(0, 10).map((m) => ({ value: m[1], label: m[2].trim() }));
      return { tag: "select", name, id, options };
    });

    // Знайдемо форму (action, method) — теж важливо для POST
    const formMatch = /<form\b[^>]*>/i.exec(html);

    // Витягнемо і невеликий шматок HTML довкола слів "Last name" / "First name",
    // щоб побачити реальну верстку таблиці (label -> input)
    const nameIdx = html.indexOf("Last name");
    const context = nameIdx >= 0 ? html.slice(Math.max(0, nameIdx - 200), nameIdx + 1200) : "не знайдено 'Last name' в HTML";

    return new Response(
      JSON.stringify(
        {
          status: res.status,
          finalUrl: res.url,
          formTag: formMatch ? formMatch[0] : null,
          inputs: inputs.filter((i) => i.name),
          selects,
          contextAroundLastName: context,
        },
        null,
        2
      ),
      { headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

