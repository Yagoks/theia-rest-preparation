// Theia - Long Rest Spell Preparation
// After a Long Rest, the owner of a configured caster chooses which spells already on the sheet are prepared. Nothing
// is created or deleted: only system.prepared changes. Configuration per actor and class lives in
// flags.world.theiaRestPreparation = { classes: { <identifier>: { enabled, additionalSources } }, unassignedClass }.
// - The window opens when the Long Rest completes (for the owner if connected, else the GM). It never opens on login.
// - "Prepare Spells" in the sheet header opens it any time; it is highlighted while a preparation is pending.

const ID = "theia-rest-preparation";
const FLAG = "theiaRestPreparation";
const { ApplicationV2 } = foundry.applications.api;
const esc = value => foundry.utils.escapeHTML(String(value ?? ""));
const configFor = actor => actor?.getFlag("world", FLAG) ?? {};
const isConfigured = actor => Object.values(configFor(actor).classes ?? {}).some(r => r?.enabled);

/* -------------------------------------------- */
/*  Rules                                       */
/* -------------------------------------------- */

export function preparationLimit(classItem) {
  const advances = Object.values(classItem.toObject().system.advancement ?? {});
  const scale = advances.find(a => a.type === "ScaleValue" &&
    (a.configuration.identifier === "prepared-spells" || a.title === "Prepared Spells"));
  if (scale) {
    const levels = Object.keys(scale.configuration.scale).map(Number).filter(n => n <= classItem.system.levels);
    const value = Number(scale.configuration.scale[Math.max(...levels)]?.value);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const value = Number(classItem.spellcasting?.preparation?.max ?? classItem.system.spellcasting?.preparation?.max);
  if (Number.isFinite(value) && value > 0) return value;
  throw new Error(`${classItem.name}: a valid preparation limit is required.`);
}

/** The configured classes of an actor, each with its limit and the spells it can prepare. */
export function classGroups(actor) {
  const config = configFor(actor);
  return Object.entries(config.classes ?? {}).flatMap(([identifier, rule]) => {
    const c = actor.itemTypes.class.find(c => c.identifier === identifier);
    if (!c || !rule.enabled) return [];
    const progression = c.system.spellcasting?.progression;
    if (progression !== "full") throw new Error(`${c.name}: this integration currently supports full casters only.`);
    const maxLevel = Math.min(9, Math.ceil(Number(c.system.levels) / 2));
    const spells = actor.itemTypes.spell.filter(s => {
      if (s.system.level < 1 || s.system.level > maxLevel || ![0, 1].includes(s.system.prepared)) return false;
      if (s.system.method !== "spell" || s.flags?.dnd5e?.cachedFor) return false;
      const source = s.system.sourceItem;
      if (!source) return config.unassignedClass === identifier;
      return source === `class:${identifier}` || (rule.additionalSources ?? []).includes(source);
    }).sort((a, b) => a.system.level - b.system.level || a.name.localeCompare(b.name));
    return [{ identifier, name: c.name, img: c.img, limit: preparationLimit(c), maxLevel, spells }];
  });
}

export function buildUpdates(groups, selected, initial) {
  const updates = [];
  const eligible = new Set(groups.flatMap(g => g.spells.map(s => s.id)));
  if ([...selected].some(id => !eligible.has(id))) throw new Error("The spell list changed. Reopen this window.");
  for (const group of groups) {
    if (group.spells.filter(s => selected.has(s.id)).length > group.limit)
      throw new Error(`${group.name}: select no more than ${group.limit} spells.`);
    for (const spell of group.spells) {
      if (initial && initial.get(spell.id) !== spell.system.prepared)
        throw new Error("Prepared spells changed while this window was open. Reopen it before saving.");
      const value = selected.has(spell.id) ? 1 : 0;
      if (spell.system.prepared !== value) updates.push({ _id: spell.id, "system.prepared": value });
    }
  }
  return updates;
}

/** Who gets the window when a rest completes: a connected player owner (their character first), else the GM. */
function targetUser(actor) {
  const owners = game.users.filter(u => u.active && !u.isGM && actor.testUserPermission(u, "OWNER"));
  return owners.find(u => u.character?.id === actor.id) ?? owners.sort((a, b) => a.id.localeCompare(b.id))[0]
    ?? game.users.activeGM;
}

/* -------------------------------------------- */
/*  Window                                      */
/* -------------------------------------------- */

const ordinal = n => ({ 1: "1st", 2: "2nd", 3: "3rd" }[n] ?? `${n}th`);

class PreparationApp extends ApplicationV2 {
  static instances = new Map();

  static DEFAULT_OPTIONS = {
    classes: ["theia-prep"],
    window: { icon: "fa-solid fa-book-open", resizable: true },
    position: { width: 620, height: 720 }
  };

  constructor(actor, { preview = false } = {}) {
    super({ id: `theia-prep-${actor.id}${preview ? "-preview" : ""}`, window: { title: `${preview ? "Preview: " : ""}Prepare Spells — ${actor.name}` } });
    this.actor = actor;
    this.preview = preview;
    this.groups = classGroups(actor);
    this.initial = new Map(this.groups.flatMap(g => g.spells.map(s => [s.id, s.system.prepared])));
    this.selected = new Set(this.groups.flatMap(g => g.spells.filter(s => s.system.prepared === 1).map(s => s.id)));
    this.pending = configFor(actor).pending ?? null;
    this.query = "";
    this.level = 0;
    this.onlyPrepared = false;
    this.saving = false;
  }

  _spellRow(s) {
    const props = s.system.properties ?? new Set();
    const school = CONFIG.DND5E.spellSchools?.[s.system.school]?.label ?? "";
    const badges = [props.has("concentration") ? '<span class="tp-badge" data-tooltip="Concentration">C</span>' : "",
      props.has("ritual") ? '<span class="tp-badge" data-tooltip="Ritual">R</span>' : ""].join("");
    const on = this.selected.has(s.id);
    return `<label class="tp-spell ${on ? "on" : ""}" data-id="${s.id}" data-name="${esc(s.name.toLowerCase())}" data-level="${s.system.level}">
      <input type="checkbox" value="${s.id}" ${on ? "checked" : ""} ${this.preview ? "disabled" : ""}>
      <span class="tp-switch" aria-hidden="true"></span>
      <img src="${esc(s.img)}" alt="">
      <span class="tp-spell-name">${esc(s.name)}</span>
      <span class="tp-spell-meta">${badges}<span class="tp-school">${esc(school)}</span></span>
      <button type="button" class="tp-view" data-view="${s.id}" data-tooltip="View spell"><i class="fa-solid fa-eye"></i></button>
    </label>`;
  }

  _groupHTML(g) {
    const levels = [...new Set(g.spells.map(s => s.system.level))];
    const body = levels.map(l => `<div class="tp-level" data-level="${l}"><h4>${ordinal(l)} level</h4>
      ${g.spells.filter(s => s.system.level === l).map(s => this._spellRow(s)).join("")}</div>`).join("");
    return `<section class="tp-class" data-class="${esc(g.identifier)}">
      <header><img src="${esc(g.img)}" alt=""><div class="tp-class-title"><b>${esc(g.name)}</b>
        <div class="tp-meter"><span class="tp-meter-fill"></span></div></div>
        <span class="tp-count"></span></header>
      ${body || '<p class="tp-empty">No spells to prepare for this class.</p>'}</section>`;
  }

  async _renderHTML() {
    const maxLevel = Math.max(0, ...this.groups.map(g => g.maxLevel));
    const chips = [0, ...Array.from({ length: maxLevel }, (_, i) => i + 1)].map(l =>
      `<button type="button" class="tp-chip ${this.level === l ? "active" : ""}" data-level-filter="${l}">${l ? l : "All"}</button>`).join("");
    const root = document.createElement("div");
    root.className = "tp-root";
    root.innerHTML = `
      <div class="tp-hero">
        <img src="${esc(this.actor.img)}" alt="">
        <div><h2>${esc(this.actor.name)}</h2>
          <p>${this.preview ? "Preview only — nothing will change."
            : this.pending ? "Long Rest complete. Choose the spells you prepare for the day." : "Choose your prepared spells."}</p></div>
      </div>
      <div class="tp-toolbar">
        <label class="tp-search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" placeholder="Search spells" value="${esc(this.query)}"></label>
        <div class="tp-chips">${chips}</div>
        <label class="tp-toggle"><input type="checkbox" class="tp-only" ${this.onlyPrepared ? "checked" : ""}> Prepared only</label>
      </div>
      <div class="tp-list">${this.groups.map(g => this._groupHTML(g)).join("")}</div>
      <p class="tp-note"><i class="fa-solid fa-circle-info"></i> Cantrips, always-prepared and innate spells don't change. Unchecked spells stay on the sheet.</p>
      <p class="tp-error" role="alert"></p>
      <footer class="tp-footer">${this.preview
        ? '<button type="button" data-act="close"><i class="fa-solid fa-xmark"></i> Close</button>'
        : `<button type="button" data-act="keep"><i class="fa-solid fa-rotate-left"></i> Keep current spells</button>
           <button type="button" data-act="save" class="tp-primary"><i class="fa-solid fa-check"></i> Save preparation</button>`}</footer>`;
    return root;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
    const el = content;
    el.querySelector(".tp-search input").addEventListener("input", ev => { this.query = ev.target.value.toLowerCase(); this._filter(); });
    el.querySelectorAll("[data-level-filter]").forEach(b => b.addEventListener("click", () => {
      this.level = Number(b.dataset.levelFilter);
      el.querySelectorAll("[data-level-filter]").forEach(x => x.classList.toggle("active", x === b));
      this._filter();
    }));
    el.querySelector(".tp-only").addEventListener("change", ev => { this.onlyPrepared = ev.target.checked; this._filter(); });
    el.querySelectorAll(".tp-spell input").forEach(inp => inp.addEventListener("change", () => {
      inp.checked ? this.selected.add(inp.value) : this.selected.delete(inp.value);
      inp.closest(".tp-spell").classList.toggle("on", inp.checked);
      this._refresh();
      this._filter();
    }));
    el.querySelectorAll("[data-view]").forEach(b => b.addEventListener("click", ev => {
      ev.preventDefault(); ev.stopPropagation();
      this.actor.items.get(b.dataset.view)?.sheet.render(true);
    }));
    el.querySelector('[data-act="save"]')?.addEventListener("click", () => this._save());
    el.querySelector('[data-act="keep"]')?.addEventListener("click", () => this._keep());
    el.querySelector('[data-act="close"]')?.addEventListener("click", () => this.close());
    this._refresh();
    this._filter();
  }

  _filter() {
    const el = this.element;
    for (const row of el.querySelectorAll(".tp-spell")) {
      const show = (!this.query || row.dataset.name.includes(this.query)) && (!this.level || Number(row.dataset.level) === this.level)
        && (!this.onlyPrepared || this.selected.has(row.dataset.id));
      row.hidden = !show;
    }
    for (const lvl of el.querySelectorAll(".tp-level")) lvl.hidden = ![...lvl.querySelectorAll(".tp-spell")].some(r => !r.hidden);
  }

  _refresh() {
    const el = this.element;
    let valid = true;
    for (const g of this.groups) {
      const count = g.spells.filter(s => this.selected.has(s.id)).length;
      const sec = el.querySelector(`.tp-class[data-class="${CSS.escape(g.identifier)}"]`);
      if (!sec) continue;
      sec.querySelector(".tp-count").textContent = `${count} / ${g.limit}`;
      sec.querySelector(".tp-meter-fill").style.width = `${Math.min(100, (count / g.limit) * 100)}%`;
      sec.classList.toggle("over", count > g.limit);
      sec.classList.toggle("full", count === g.limit);
      if (count > g.limit) valid = false;
    }
    const save = el.querySelector('[data-act="save"]');
    if (save) save.disabled = !valid || this.saving;
    el.querySelector(".tp-error").textContent = valid ? "" : "Too many spells prepared: uncheck some before saving.";
  }

  async _save() {
    if (this.saving) return;
    this.saving = true;
    this._refresh();
    try {
      if ((configFor(this.actor).pending ?? null) !== this.pending) throw new Error("A new rest was completed. Reopen preparation.");
      const updates = buildUpdates(classGroups(this.actor), this.selected, this.initial);
      if (updates.length) await this.actor.updateEmbeddedDocuments("Item", updates);
      if (this.pending) await this.actor.unsetFlag("world", `${FLAG}.pending`);
      ui.notifications.info(`${this.actor.name}: spell preparation saved.`);
      await this.close();
    } catch (error) {
      this.saving = false;
      this._refresh();
      this.element.querySelector(".tp-error").textContent = error.message;
    }
  }

  async _keep() {
    if (this.pending && configFor(this.actor).pending === this.pending) await this.actor.unsetFlag("world", `${FLAG}.pending`);
    await this.close();
  }

  async _onClose(options) {
    PreparationApp.instances.delete(this.id);
    return super._onClose?.(options);
  }
}

export async function openPreparation(actor, { preview = false } = {}) {
  if (!actor?.isOwner) return ui.notifications.warn("You do not own this character.");
  const id = `theia-prep-${actor.id}${preview ? "-preview" : ""}`;
  const open = PreparationApp.instances.get(id);
  if (open?.rendered) return open.bringToFront();
  let groups;
  try { groups = classGroups(actor); } catch (error) { return ui.notifications.error(error.message); }
  if (!groups.length) return ui.notifications.info("This character does not prepare spells after a Long Rest.");
  const app = new PreparationApp(actor, { preview });
  PreparationApp.instances.set(id, app);
  await app.render(true);
  return app;
}

/** Open the window for the user who should answer it (the owner if connected, else the GM). */
function maybeOpen(actor) {
  if (!configFor(actor).pending || targetUser(actor)?.id !== game.user.id) return;
  openPreparation(actor).catch(error => { console.error(ID, error); ui.notifications.error(error.message); });
}

/* -------------------------------------------- */
/*  Setup                                       */
/* -------------------------------------------- */

Hooks.once("ready", () => {
  if (game.system.id !== "dnd5e") return;
  game.modules.get(ID).api = { open: openPreparation, preview: actor => openPreparation(actor, { preview: true }), classGroups };

  // The client completing the rest marks the preparation as pending; the flag reaches the owner, whose client opens it.
  Hooks.on("dnd5e.restCompleted", async (actor, result) => {
    if (!result.longRest || !actor.isOwner || !isConfigured(actor)) return;
    try {
      if (!classGroups(actor).length) return;
      await actor.setFlag("world", `${FLAG}.pending`, foundry.utils.randomID());
    } catch (error) { console.error(ID, error); ui.notifications.error(error.message); }
  });
  // Only a new pending preparation opens the window (never a login with an old one still pending).
  Hooks.on("updateActor", (actor, changes) => {
    if (foundry.utils.getProperty(changes, `flags.world.${FLAG}.pending`)) maybeOpen(actor);
  });

  // "Prepare Spells" in the sheet header of configured casters, highlighted while a preparation is pending.
  Hooks.on("getHeaderControlsApplicationV2", (app, controls) => {
    const actor = app.document;
    if (!(actor instanceof Actor) || !actor.isOwner || !isConfigured(actor)) return;
    controls.unshift({
      action: "theiaPrepareSpells",
      icon: "fa-solid fa-book-open",
      label: configFor(actor).pending ? "Prepare Spells (pending)" : "Prepare Spells",
      onClick: () => openPreparation(actor)
    });
  });
});
