<script lang="ts">
  import PwaUpdate from "./PwaUpdate.svelte";
  import {
    formatClock,
    formatCountdown,
    formatWalk,
    nextDeparture,
    clampInt,
    parseTimeToMinutes,
  } from "./lib/time";
  import {
    loadLocations,
    saveLocations,
    loadSelection,
    saveSelection,
    seedLocations,
    uid,
    type TransitLocation,
    type Station,
  } from "./lib/store";

  // ---------- state ----------
  let locations = $state<TransitLocation[]>(loadLocations());
  const initialSel = loadSelection();
  let selectedLocationId = $state<string | null>(initialSel.locationId);
  let selectedStationId = $state<string | null>(initialSel.stationId);
  let mode = $state<"leave" | "transit">("leave");
  let now = $state(new Date());
  let manageOpen = $state(false);
  let newLocationName = $state("");

  // location rename editor
  let editingLocationId = $state<string | null>(null);
  let editingLocationName = $state("");

  // station editor (shared draft; only one open at a time)
  // key is `${locId}:new` or `${locId}:${stationId}`
  let editingStationKey = $state<string | null>(null);
  let draftName = $state("");
  let draftWalk = $state("8");
  let draftFirst = $state("05:30");
  let draftFreq = $state("15");
  let draftError = $state<string | null>(null);

  // ticking clock
  $effect(() => {
    const t = setInterval(() => (now = new Date()), 500);
    return () => clearInterval(t);
  });

  // persist
  $effect(() => saveLocations(locations));
  $effect(() => saveSelection({ locationId: selectedLocationId, stationId: selectedStationId }));

  // keep selection ids valid when data changes
  $effect(() => {
    if (locations.length === 0) {
      selectedLocationId = null;
      selectedStationId = null;
      return;
    }
    const locOk = locations.some((l) => l.id === selectedLocationId);
    if (!locOk) {
      selectedLocationId = locations[0]!.id;
      selectedStationId = null;
    }
    const loc = locations.find((l) => l.id === selectedLocationId);
    if (loc && loc.stations.length > 0 && !loc.stations.some((s) => s.id === selectedStationId)) {
      selectedStationId = loc.stations[0]!.id;
    }
    if (loc && loc.stations.length === 0) selectedStationId = null;
  });

  // ---------- derived selection ----------
  let selectedLocation: TransitLocation | null = $derived(
    locations.find((l) => l.id === selectedLocationId) ?? null,
  );
  let selectedStation: Station | null = $derived(
    selectedLocation
      ? (selectedLocation.stations.find((s) => s.id === selectedStationId) ??
        selectedLocation.stations[0] ??
        null)
      : null,
  );

  // ---------- timer math ----------
  interface Plan {
    immediate: Date | null;
    catchable: Date | null;
    leaveBy: Date | null;
    missed: boolean;
    countdownMs: number | null;
    countdownLabel: string;
    subLabel: string;
  }

  function emptyPlan(subLabel: string): Plan {
    return {
      immediate: null,
      catchable: null,
      leaveBy: null,
      missed: false,
      countdownMs: null,
      countdownLabel: "--:--",
      subLabel,
    };
  }

  let plan: Plan = $derived.by(() => {
    const st = selectedStation;
    if (!st) return emptyPlan("Add a station to start the countdown");
    const freq = Math.floor(Number(st.frequencyMinutes));
    const walk = Math.max(0, Number(st.walkMinutes) || 0);
    if (!Number.isFinite(freq) || freq <= 0 || parseTimeToMinutes(st.firstDeparture) === null) {
      return emptyPlan("Fix this station's timetable to start the countdown");
    }

    const immediate = nextDeparture(now, st.firstDeparture, freq);
    const arrivalNeed = new Date(now.getTime() + walk * 60_000);
    const catchable = nextDeparture(arrivalNeed, st.firstDeparture, freq);
    if (!immediate || !catchable) return emptyPlan("Could not compute departures");

    const missed = catchable.getTime() !== immediate.getTime();
    const leaveBy = new Date(catchable.getTime() - walk * 60_000);

    if (mode === "transit") {
      const ms = Math.max(0, immediate.getTime() - now.getTime());
      return {
        immediate,
        catchable,
        leaveBy,
        missed,
        countdownMs: ms,
        countdownLabel: formatCountdown(ms),
        subLabel: `next transit at ${formatClock(immediate)} · every ${freq} min`,
      };
    }

    const ms = Math.max(0, leaveBy.getTime() - now.getTime());
    const urgent = ms <= 60_000;
    return {
      immediate,
      catchable,
      leaveBy,
      missed,
      countdownMs: ms,
      countdownLabel: formatCountdown(ms),
      subLabel: missed
        ? `missed the ${formatClock(immediate)} — next catchable at ${formatClock(catchable)}`
        : urgent
          ? `leave now — transit at ${formatClock(catchable)}`
          : `to catch the ${formatClock(catchable)} · ${formatWalk(walk)} on foot`,
    };
  });

  let heroKicker: string = $derived(
    !selectedLocation || !selectedStation ? "transit" : mode === "leave" ? "leave in" : "transit in",
  );
  let heroTitle: string = $derived(
    !selectedLocation || !selectedStation
      ? "No station yet"
      : `${selectedLocation.name || "Unnamed location"} → ${selectedStation.name || "Unnamed station"}`,
  );

  // ---------- location CRUD ----------
  function addLocation() {
    const name = newLocationName.trim() || `Location ${locations.length + 1}`;
    const loc: TransitLocation = { id: uid(), name, stations: [] };
    locations = [...locations, loc];
    selectedLocationId = loc.id;
    selectedStationId = null;
    newLocationName = "";
    manageOpen = true;
  }
  function startRenameLocation(loc: TransitLocation) {
    editingLocationId = loc.id;
    editingLocationName = loc.name;
  }
  function saveRenameLocation(id: string) {
    const clean = editingLocationName.trim();
    if (!clean) return;
    locations = locations.map((l) => (l.id === id ? { ...l, name: clean } : l));
    editingLocationId = null;
  }
  function deleteLocation(id: string) {
    locations = locations.filter((l) => l.id !== id);
  }
  function loadDemo() {
    const seed = seedLocations();
    locations = seed;
    selectedLocationId = seed[0]?.id ?? null;
    selectedStationId = seed[0]?.stations[0]?.id ?? null;
  }

  // ---------- station CRUD ----------
  function openNewStation(locId: string) {
    draftName = "";
    draftWalk = "8";
    draftFirst = "05:30";
    draftFreq = "15";
    draftError = null;
    editingStationKey = `${locId}:new`;
  }
  function openEditStation(locId: string, st: Station) {
    draftName = st.name;
    draftWalk = String(st.walkMinutes);
    draftFirst = st.firstDeparture;
    draftFreq = String(st.frequencyMinutes);
    draftError = null;
    editingStationKey = `${locId}:${st.id}`;
  }
  function validateDraft(): string | null {
    if (!draftName.trim()) return "Give the station a name.";
    const walk = Number(draftWalk);
    if (!Number.isFinite(walk) || walk < 0 || walk > 600) return "Walk time must be 0–600 minutes.";
    if (parseTimeToMinutes(draftFirst) === null) return "Timetable start must be HH:MM (24h).";
    const freq = Number(draftFreq);
    if (!Number.isFinite(freq) || freq < 1 || freq > 720) return "Frequency must be 1–720 minutes.";
    return null;
  }
  function saveStation(locId: string) {
    const err = validateDraft();
    if (err) {
      draftError = err;
      return;
    }
    const key = editingStationKey ?? "";
    const isNew = key.endsWith(":new");
    const stationId = isNew ? uid() : (key.split(":")[1] ?? uid());
    const payload: Station = {
      id: stationId,
      name: draftName.trim(),
      walkMinutes: clampInt(Number(draftWalk), 0, 600, 8),
      firstDeparture: draftFirst.trim(),
      frequencyMinutes: clampInt(Number(draftFreq), 1, 720, 15),
    };
    locations = locations.map((l) => {
      if (l.id !== locId) return l;
      const stations = isNew
        ? [...l.stations, payload]
        : l.stations.map((s) => (s.id === payload.id ? payload : s));
      return { ...l, stations };
    });
    selectedLocationId = locId;
    selectedStationId = payload.id;
    mode = "leave";
    editingStationKey = null;
    draftError = null;
  }
  function deleteStation(locId: string, stationId: string) {
    locations = locations.map((l) =>
      l.id === locId ? { ...l, stations: l.stations.filter((s) => s.id !== stationId) } : l,
    );
    editingStationKey = null;
  }

  function useStation(locId: string, stationId: string) {
    selectedLocationId = locId;
    selectedStationId = stationId;
    mode = "leave";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
</script>

<main class="page">
  <p class="eyebrow">transit · leave on time</p>

  <!-- selectors -->
  <div class="mt-6 flex flex-wrap gap-2">
    {#if locations.length === 0}
      <span class="chip">no locations yet</span>
    {:else}
      <label class="field-inline">
        <span>From</span>
        <select
          class="select"
          value={selectedLocation?.id ?? ""}
          onchange={(e) => {
            selectedLocationId = e.currentTarget.value || null;
            selectedStationId = null;
            mode = "leave";
          }}
        >
          {#each locations as loc (loc.id)}
            <option value={loc.id}>{loc.name || "Unnamed location"}</option>
          {/each}
        </select>
      </label>
      {#if selectedLocation && selectedLocation.stations.length > 0}
        <label class="field-inline">
          <span>Destination</span>
          <select
            class="select"
            value={selectedStation?.id ?? ""}
            onchange={(e) => {
              selectedStationId = e.currentTarget.value || null;
              mode = "leave";
            }}
          >
            {#each selectedLocation.stations as st (st.id)}
              <option value={st.id}>{st.name || "Unnamed station"}</option>
            {/each}
          </select>
        </label>
      {/if}
    {/if}
  </div>

  <!-- hero timer -->
  <section aria-live="polite" class="hero">
    <p class="hero-kicker">{heroKicker}</p>
    <p class="hero-timer">{plan.countdownLabel}</p>
    <h1 class="hero-title">{heroTitle}</h1>
    <p class="hero-sub">{plan.subLabel}</p>

    {#if selectedStation}
      <div class="hero-meta">
        <span>🚶 {formatWalk(selectedStation.walkMinutes)}</span>
        <span aria-hidden="true" class="dot"></span>
        <span>🕐 first {selectedStation.firstDeparture}</span>
        <span aria-hidden="true" class="dot"></span>
        <span>🔁 every {selectedStation.frequencyMinutes} min</span>
      </div>
      {#if plan.leaveBy && mode === "leave"}
        <p class="hero-leaveby">
          leave by <strong>{formatClock(plan.leaveBy)}</strong>
          {#if plan.catchable} · transit at <strong>{formatClock(plan.catchable)}</strong>{/if}
        </p>
      {/if}
      {#if plan.missed && mode === "leave"}
        <p class="missed">
          You can't make the {plan.immediate ? formatClock(plan.immediate) : ""} on foot — showing
          the next one.
        </p>
      {/if}
    {/if}

    <div class="hero-actions">
      {#if mode === "leave"}
        <button
          type="button"
          class="btn-primary"
          disabled={!selectedStation}
          onclick={() => (mode = "transit")}
        >
          Start
        </button>
        <span class="hint">Start switches to “next transit in …”</span>
      {:else}
        <button type="button" class="btn-primary" onclick={() => (mode = "leave")}>
          Back to leave timer
        </button>
        <span class="hint">Showing arrival countdown — you're on your way</span>
      {/if}
    </div>
  </section>

  <!-- empty / onboarding -->
  {#if locations.length === 0}
    <section class="card">
      <h2 class="h2">Set up your first location</h2>
      <p class="body">
        Locations are places you leave from (home, office…). Each one holds the stations you can
        walk to, with walk time + timetable.
      </p>
      <div class="row">
        <input
          class="input"
          placeholder="e.g. Home"
          bind:value={newLocationName}
          onkeydown={(e) => e.key === "Enter" && addLocation()}
        />
        <button type="button" class="btn-solid" onclick={addLocation}>Add location</button>
      </div>
      <div class="row">
        <button type="button" class="link-quiet" onclick={loadDemo}>or load a demo location</button>
      </div>
    </section>
  {/if}

  <!-- manage -->
  <section class="section">
    <button
      type="button"
      class="manage-toggle"
      aria-expanded={manageOpen}
      onclick={() => (manageOpen = !manageOpen)}
    >
      <span>{manageOpen ? "▾" : "▸"} Manage locations & stations</span>
      <span class="count"
        >{locations.length} {locations.length === 1 ? "location" : "locations"}</span
      >
    </button>

    {#if manageOpen}
      <div class="row mt-4">
        <input
          class="input"
          placeholder="New location name"
          bind:value={newLocationName}
          onkeydown={(e) => e.key === "Enter" && addLocation()}
        />
        <button type="button" class="btn-solid" onclick={addLocation}>Add</button>
      </div>

      {#each locations as loc (loc.id)}
        <article class="card">
          <div class="card-head">
            {#if editingLocationId === loc.id}
              <div class="row">
                <input
                  class="input"
                  placeholder="Location name"
                  bind:value={editingLocationName}
                  onkeydown={(e) => {
                    if (e.key === "Enter") saveRenameLocation(loc.id);
                    if (e.key === "Escape") editingLocationId = null;
                  }}
                />
                <button type="button" class="btn-solid" onclick={() => saveRenameLocation(loc.id)}>
                  Save
                </button>
                <button type="button" class="btn-quiet" onclick={() => (editingLocationId = null)}>
                  Cancel
                </button>
              </div>
            {:else}
              <h3 class="card-title">{loc.name || "Unnamed location"}</h3>
              <div class="card-tools">
                <button type="button" class="btn-quiet" onclick={() => startRenameLocation(loc)}>
                  Rename
                </button>
                <button type="button" class="btn-danger" onclick={() => deleteLocation(loc.id)}>
                  Delete
                </button>
              </div>
            {/if}
          </div>

          {#if loc.stations.length === 0 && editingStationKey !== `${loc.id}:new`}
            <p class="body">No stations yet — add the stop you walk to.</p>
          {/if}

          <ul class="station-list">
            {#each loc.stations as st (st.id)}
              {@const key = `${loc.id}:${st.id}`}
              <li class="station">
                {#if editingStationKey === key}
                  <div class="form-grid">
                    <label class="field">
                      <span>Station name</span>
                      <input class="input" bind:value={draftName} placeholder="e.g. Main station" />
                    </label>
                    <label class="field">
                      <span>Walk (min)</span>
                      <input class="input" inputmode="numeric" bind:value={draftWalk} />
                    </label>
                    <label class="field">
                      <span>Timetable starts</span>
                      <input class="input" type="time" bind:value={draftFirst} />
                    </label>
                    <label class="field">
                      <span>Every (min)</span>
                      <input class="input" inputmode="numeric" bind:value={draftFreq} />
                    </label>
                  </div>
                  {#if draftError}
                    <p class="form-error">{draftError}</p>
                  {/if}
                  <div class="row">
                    <button type="button" class="btn-solid" onclick={() => saveStation(loc.id)}>
                      Save station
                    </button>
                    <button type="button" class="btn-quiet" onclick={() => (editingStationKey = null)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      class="btn-danger"
                      onclick={() => deleteStation(loc.id, st.id)}
                    >
                      Delete
                    </button>
                  </div>
                {:else}
                  <div class="station-row">
                    <div>
                      <p class="station-name">{st.name || "Unnamed station"}</p>
                      <p class="station-sub">
                        🚶 {formatWalk(st.walkMinutes)} · first {st.firstDeparture} · every {st.frequencyMinutes}
                        min
                      </p>
                    </div>
                    <div class="card-tools">
                      <button
                        type="button"
                        class="btn-quiet"
                        onclick={() => useStation(loc.id, st.id)}
                      >
                        Use
                      </button>
                      <button type="button" class="btn-quiet" onclick={() => openEditStation(loc.id, st)}>
                        Edit
                      </button>
                    </div>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>

          {#if editingStationKey === `${loc.id}:new`}
            <div class="station station-edit">
              <div class="form-grid">
                <label class="field">
                  <span>Station name</span>
                  <input class="input" bind:value={draftName} placeholder="e.g. Main station" />
                </label>
                <label class="field">
                  <span>Walk (min)</span>
                  <input class="input" inputmode="numeric" bind:value={draftWalk} />
                </label>
                <label class="field">
                  <span>Timetable starts</span>
                  <input class="input" type="time" bind:value={draftFirst} />
                </label>
                <label class="field">
                  <span>Every (min)</span>
                  <input class="input" inputmode="numeric" bind:value={draftFreq} />
                </label>
              </div>
              {#if draftError}
                <p class="form-error">{draftError}</p>
              {/if}
              <div class="row">
                <button type="button" class="btn-solid" onclick={() => saveStation(loc.id)}>
                  Add station
                </button>
                <button type="button" class="btn-quiet" onclick={() => (editingStationKey = null)}>
                  Cancel
                </button>
              </div>
            </div>
          {:else}
            <button type="button" class="btn-ghost" onclick={() => openNewStation(loc.id)}>
              + Add station
            </button>
          {/if}
        </article>
      {/each}
    {/if}
  </section>

  <p class="footnote">times are local · data stays in your browser</p>
</main>

<PwaUpdate />
