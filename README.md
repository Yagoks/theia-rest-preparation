# Theia - Long Rest Spell Preparation

After a Long Rest, the owner of a spellcaster picks which spells **already on the sheet** are prepared. Nothing is
created or deleted: only the prepared state changes. Foundry VTT v13, dnd5e 5.x.

## How it works
- **After a Long Rest** the preparation window opens for the character's owner (their player if connected, otherwise
  the GM). It never opens on login.
- **Prepare Spells** in the character sheet header opens it any time. While a preparation is pending (a rest was
  taken and not answered yet) the button says *Prepare Spells (pending)*.
- The window shows one card per configured class with its limit (`x / limit` and a bar), the spells grouped by level
  with their school and Concentration / Ritual marks, a search box, level filters and *Prepared only*.
- **Save preparation** applies the choice; **Keep current spells** closes it without changes. Saving is refused above a
  class's limit, if the spells changed meanwhile, or if a newer rest was taken.
- Cantrips, always-prepared and innate spells are never touched.

## Configuration (per actor)
`flags.world.theiaRestPreparation`:
```json
{ "unassignedClass": "wizard-theia",
  "classes": { "wizard-theia": { "enabled": true, "additionalSources": ["feat:spellcasting"] } } }
```
- `classes`: the class identifiers that prepare spells after a Long Rest (full casters only).
- `unassignedClass`: the class that owns spells with no source item.
- `additionalSources`: other source items (`feat:<identifier>`) whose spells count for that class.
- Limit: the class's *Prepared Spells* scale value (identifier `prepared-spells`), else the system's preparation max.

## API
`game.modules.get("theia-rest-preparation").api` — `open(actor)`, `preview(actor)` (read only), `classGroups(actor)`.

## Install
Manifest: `https://github.com/Yagoks/theia-rest-preparation/releases/latest/download/module.json`
