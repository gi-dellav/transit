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
  let aboutOpen = $state(false);
  let newLocationName = $state("");

  // browser notification reminder for leaveBy (opt-in, persisted)
  const notifySupported = typeof window !== "undefined" && "Notification" in window;
  let notifyArmed = $state(false);
  let notifyDenied = $state(false);
  let notifiedLeaveBy = $state(0);

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

  // restore notification choice
  $effect(() => {
    if (!notifySupported) return;
    try {
      notifyDenied = Notification.permission === "denied";
      notifyArmed = localStorage.getItem("transit.notify") === "on";
    } catch {
      // ignore
    }
  });

  async function toggleNotify() {
    if (!notifySupported) return;
    if (!notifyArmed) {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        notifyArmed = false;
        notifyDenied = Notification.permission === "denied";
        try {
          localStorage.setItem("transit.notify", "off");
        } catch {
          // ignore
        }
        return;
      }
      notifiedLeaveBy = 0;
      notifyDenied = false;
    }
    notifyArmed = !notifyArmed;
    try {
      localStorage.setItem("transit.notify", notifyArmed ? "on" : "off");
    } catch {
      // ignore
    }
    // Turning off cancels any trigger-scheduled notification + pending timer.
    if (!notifyArmed) {
      try {
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.getNotifications({ tag: "transit-leaveby" });
        existing.forEach((n) => n.close());
      } catch {
        // ignore (no SW / unsupported)
      }
    }
  }

  async function showLeaveNotification(title: string, body: string) {
    // Preferred path: via the service worker so the notification can outlive
    // the tab and clicking it refocuses the app (see src/sw.ts).
    try {
      if ("serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification(
          title,
          {
            body,
            tag: "transit-leaveby",
            icon: `${import.meta.env.BASE_URL}pwa-192x192.png`,
            badge: `${import.meta.env.BASE_URL}pwa-192x192.png`,
            renotify: true,
          } as NotificationOptions,
        );
        return;
      }
    } catch {
      // fall through to the page-context Notification below
    }
    try {
      new Notification(title, { body, tag: "transit-leaveby" });
    } catch {
      // ignore (e.g. permission revoked mid-session)
    }
  }

  // fire the leaveBy notification once per departure
  $effect(() => {
    if (!notifyArmed || !notifySupported || Notification.permission !== "granted") return;
    if (mode !== "leave" || !plan.leaveBy || plan.leaveBy.getTime() === notifiedLeaveBy) return;
    const delay = plan.leaveBy.getTime() - Date.now();
    if (!Number.isFinite(delay) || delay <= 0) return;
    const id = plan.leaveBy.getTime();
    const target = plan.catchable ? formatClock(plan.catchable) : "";
    const route =
      selectedLocation && selectedStation
        ? ` · ${selectedLocation.name || "Unnamed"} → ${selectedStation.name || "Unnamed"}`
        : "";
    const title = "Leave now";
    const body = target ? `transit at ${target}${route}` : `time to leave${route}`;

    // Where supported (Chrome's Notification Triggers API), schedule directly
    // in the service worker so it fires even if this tab is closed.
    const TimestampTrigger = (window as unknown as { TimestampTrigger?: unknown }).TimestampTrigger;
    if (typeof TimestampTrigger === "function") {
      let cancelled = false;
      (async () => {
        try {
          const reg = await navigator.serviceWorker.ready;
          if (cancelled) return;
          await reg.showNotification(
            title,
            {
              body,
              tag: "transit-leaveby",
              icon: `${import.meta.env.BASE_URL}pwa-192x192.png`,
              badge: `${import.meta.env.BASE_URL}pwa-192x192.png`,
              renotify: true,
              // showTrigger is part of the experimental Notification Triggers
              // API (Chrome-only), not yet in TS DOM libs.
              showTrigger: new (TimestampTrigger as new (t: number) => unknown)(id),
            } as NotificationOptions,
          );
          notifiedLeaveBy = id;
        } catch {
          // Trigger scheduling failed (e.g. too far in future) — fall back
          // to the in-page timer below by resetting so a retry can occur.
        }
      })();
      return () => {
        cancelled = true;
      };
    }

    const timer = setTimeout(() => {
      notifiedLeaveBy = id;
      void showLeaveNotification(title, body);
    }, Math.min(delay, 2_147_483_647));
    return () => clearTimeout(timer);
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
    if (!st) return emptyPlan("Add a station below to start");
    const freq = Math.floor(Number(st.frequencyMinutes));
    const walk = Math.max(0, Number(st.walkMinutes) || 0);
    if (!Number.isFinite(freq) || freq <= 0 || parseTimeToMinutes(st.firstDeparture) === null) {
      return emptyPlan("Fix the timetable below to start");
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
        subLabel: `at ${formatClock(immediate)}`,
      };
    }

    const ms = Math.max(0, leaveBy.getTime() - now.getTime());
    if (missed) {
      return {
        immediate,
        catchable,
        leaveBy,
        missed,
        countdownMs: ms,
        countdownLabel: formatCountdown(ms),
        subLabel: `missed ${formatClock(immediate)} · leave by ${formatClock(leaveBy)} for ${formatClock(catchable)}`,
      };
    }
    if (ms <= 60_000) {
      return {
        immediate,
        catchable,
        leaveBy,
        missed,
        countdownMs: ms,
        countdownLabel: formatCountdown(ms),
        subLabel: `leave now · ${formatClock(catchable)}`,
      };
    }
    return {
      immediate,
      catchable,
      leaveBy,
      missed,
      countdownMs: ms,
      countdownLabel: formatCountdown(ms),
      subLabel: `leave by ${formatClock(leaveBy)} · ${formatClock(catchable)}`,
    };
  });

  let heroKicker: string = $derived(mode === "leave" ? "leave in" : "transit in");
  let heroTitle: string = $derived(
    !selectedLocation || !selectedStation
      ? ""
      : `${selectedLocation.name || "Unnamed location"} → ${selectedStation.name || "Unnamed station"}`,
  );

  // Only show switchers when there's actually a choice to make.
  let showLocationSwitcher: boolean = $derived(locations.length > 1);
  let showStationSwitcher: boolean = $derived((selectedLocation?.stations.length ?? 0) > 1);
  let showTitle: boolean = $derived(showLocationSwitcher || showStationSwitcher);

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
</script>

<main class="page">
  <!-- info -->
  <div class="info-wrap">
    <button
      type="button"
      class="info-text"
      aria-label="About Transit"
      aria-expanded={aboutOpen}
      onclick={() => (aboutOpen = !aboutOpen)}
    >
      info
    </button>
    {#if aboutOpen}
      <div class="about-card-top" role="dialog" aria-label="About Transit">
        <p class="about-title">Transit</p>
        <p class="about-sub">Built by Giuseppe Della Vedova</p>
        <div class="about-links">
          <a
            class="about-link"
            href="https://github.com/gi-dellav/transit"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
          <a
            class="about-link"
            href="https://www.linkedin.com/in/giuseppe-della-vedova-a2890a413/"
            target="_blank"
            rel="noopener noreferrer"
          >
            LinkedIn
          </a>
        </div>
      </div>
    {/if}
  </div>

  {#if showLocationSwitcher || showStationSwitcher}
    <div class="switchers">
      {#if showLocationSwitcher}
        <select
          class="switcher"
          aria-label="Location"
          value={selectedLocation?.id ?? ""}
          onchange={(e) => {
            selectedLocationId = e.currentTarget.value || null;
            selectedStationId = null;
            mode = "leave";
          }}
        >
          {#each locations as loc (loc.id)}
            <option value={loc.id}>{loc.name || "Unnamed"}</option>
          {/each}
        </select>
      {/if}
      {#if showStationSwitcher && selectedLocation}
        <select
          class="switcher"
          aria-label="Station"
          value={selectedStation?.id ?? ""}
          onchange={(e) => {
            selectedStationId = e.currentTarget.value || null;
            mode = "leave";
          }}
        >
          {#each selectedLocation.stations as st (st.id)}
            <option value={st.id}>{st.name || "Unnamed"}</option>
          {/each}
        </select>
      {/if}
    </div>
  {/if}

  <!-- hero timer -->
  <section aria-live="polite" class="hero">
    <p class="hero-kicker">{heroKicker}</p>
    <p class="hero-timer">{plan.countdownLabel}</p>
    {#if showTitle}
      <h1 class="hero-title">{heroTitle}</h1>
    {/if}
    <p class="hero-sub">{plan.subLabel}</p>

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
        {#if notifySupported && selectedStation && plan.leaveBy}
          <button
            type="button"
            class="notify-toggle"
            aria-pressed={notifyArmed}
            onclick={toggleNotify}
          >
            {notifyArmed ? "reminder on" : "remind me"}
          </button>
          {#if notifyDenied && !notifyArmed}
            <p class="hint">notifications blocked — allow them in your browser settings</p>
          {/if}
        {/if}
      {:else}
        <button type="button" class="btn-primary" onclick={() => (mode = "leave")}> Back </button>
      {/if}
    </div>
  </section>

  <!-- empty / onboarding -->
  {#if locations.length === 0}
    <section class="card">
      <h2 class="h2">Where do you start your journey?</h2>
      <div class="row">
        <input
          class="input"
          placeholder="e.g. Home"
          bind:value={newLocationName}
          onkeydown={(e) => e.key === "Enter" && addLocation()}
        />
        <button type="button" class="btn-solid" onclick={addLocation}>Add</button>
      </div>
      <div class="row">
        <button type="button" class="link-quiet" onclick={loadDemo}>or load demo</button>
      </div>
    </section>
  {/if}

  <!-- manage -->
  <section class="manage">
    <button type="button" class="link-quiet" aria-expanded={manageOpen} onclick={() => (manageOpen = !manageOpen)}>
      {manageOpen ? "Done" : "Edit"}
    </button>

    {#if manageOpen}
      <div class="row mt-4">
        <input
          class="input"
          placeholder="New location"
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
              <h3 class="card-title">{loc.name || "Unnamed"}</h3>
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

          <ul class="station-list">
            {#each loc.stations as st (st.id)}
              {@const key = `${loc.id}:${st.id}`}
              <li class="station">
                {#if editingStationKey === key}
                  <div class="form-grid">
                    <label class="field">
                      <span>Name</span>
                      <input class="input" bind:value={draftName} placeholder="e.g. Main station" />
                    </label>
                    <label class="field">
                      <span>Walk (min)</span>
                      <input class="input" inputmode="numeric" bind:value={draftWalk} />
                    </label>
                    <label class="field">
                      <span>Starts</span>
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
                      Save
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
                      <p class="station-name">{st.name || "Unnamed"}</p>
                      <p class="station-sub">
                        {formatWalk(st.walkMinutes)} · {st.firstDeparture} · /{st.frequencyMinutes}
                      </p>
                    </div>
                    <button type="button" class="btn-quiet" onclick={() => openEditStation(loc.id, st)}>
                      Edit
                    </button>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>

          {#if editingStationKey === `${loc.id}:new`}
            <div class="station station-edit">
              <div class="form-grid">
                <label class="field">
                  <span>Name</span>
                  <input class="input" bind:value={draftName} placeholder="e.g. Main station" />
                </label>
                <label class="field">
                  <span>Walk (min)</span>
                  <input class="input" inputmode="numeric" bind:value={draftWalk} />
                </label>
                <label class="field">
                  <span>Starts</span>
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
                  Add
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
</main>

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape") aboutOpen = false;
  }}
  onclick={(e) => {
    if (aboutOpen && !(e.target as HTMLElement).closest(".info-wrap")) aboutOpen = false;
  }}
/>

<PwaUpdate />
