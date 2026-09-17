/**
 * Curated ZzFX procedural presets (MIT — ZzFX).
 * @see https://github.com/KilledByAPixel/ZzFX — designer: https://killedbyapixel.github.io/ZzFX
 */

export interface ZzfxSfxPreset {
  id: string
  name: string
  /** Parameter list for ZZFX.buildSamples / zzfx() — sparse arrays use defaults */
  zzfx: number[]
}

export interface ZzfxSfxCategory {
  id: string
  label: string
  presets: ZzfxSfxPreset[]
}

/** SFX browse category (`id` + `label`). */
export interface SfxBrowseCategory {
  id: string
  label: string
}

/** Categories for the Audio tab grid (library is 100% client-side ZzFX). */
export const ZZFX_SFX_CATEGORIES = [
  {
    id: 'ui',
    label: 'UI & clicks',
    presets: [
      { id: 'ui-tick', name: 'Soft tick', zzfx: [1, , 880, 0.01, 0.01, 0.08, 0, 1.2] },
      { id: 'ui-click', name: 'Click', zzfx: [1.2, , 1200, 0.002, 0.01, 0.06, 1, 0.8] },
      { id: 'ui-toggle', name: 'Toggle', zzfx: [0.9, , 600, 0.005, 0.02, 0.12, 2, 1.5] },
      { id: 'ui-beep-hi', name: 'Beep high', zzfx: [0.8, , 1400, 0.001, 0.02, 0.1, 0, 1] },
      { id: 'ui-beep-lo', name: 'Beep low', zzfx: [0.8, , 220, 0.002, 0.03, 0.15, 0, 1] },
      { id: 'ui-chime', name: 'Chime', zzfx: [1, , 990, 0.02, 0.08, 0.25, 0, 1.4, , , , , , , , 0.2] },
      { id: 'ui-swipe', name: 'Swipe', zzfx: [0.85, , 600, 0.04, 0.06, 0.18, 0, 2.2, 40] },
      { id: 'ui-success', name: 'Success', zzfx: [1.1, , 520, 0.01, 0.08, 0.22, 1, 1.4, 6, 2] },
      { id: 'ui-deny', name: 'Denied', zzfx: [1, , 140, 0.04, 0.12, 0.35, 1, 0.6, -12] },
      { id: 'ui-hover', name: 'Hover', zzfx: [0.45, , 920, 0.003, 0.015, 0.07, 0, 1.3] },
      { id: 'ui-tap', name: 'Tap', zzfx: [1, , 1050, 0.001, 0.012, 0.055, 1, 0.9] },
      { id: 'ui-send', name: 'Send / submit', zzfx: [1, , 680, 0.008, 0.04, 0.16, 1, 1.5, 4] },
      { id: 'ui-open', name: 'Panel open', zzfx: [0.95, , 340, 0.02, 0.08, 0.28, 0, 1.8, 35] },
      { id: 'ui-close', name: 'Panel close', zzfx: [0.9, , 420, 0.02, 0.06, 0.22, 0, 1.6, -28] },
      { id: 'ui-menu', name: 'Menu fold', zzfx: [0.85, , 240, 0.015, 0.05, 0.2, 2, 1.4] },
      { id: 'ui-type', name: 'Type key', zzfx: [0.55, , 1600, 0.001, 0.008, 0.04, 4, 2.2, , , , 0.35] },
      { id: 'ui-bright', name: 'Bright ping', zzfx: [1.1, , 1100, 0.004, 0.03, 0.14, 2, 2.2, , 12] },
    ],
  },
  {
    id: 'impacts',
    label: 'Impacts & hits',
    presets: [
      { id: 'impact-punch', name: 'Punch', zzfx: [1.4, , 150, 0.01, 0.04, 0.35, 4, 2.5, , , , , , , , 0.15] },
      { id: 'impact-thud', name: 'Thud', zzfx: [1.2, , 80, 0.02, 0.06, 0.4, 3, 1.2] },
      { id: 'impact-slam', name: 'Slam', zzfx: [1.5, , 55, 0.005, 0.02, 0.55, 4, 3] },
      { id: 'impact-metal', name: 'Metal hit', zzfx: [1.1, , 320, 0.01, 0.03, 0.2, 3, 2, , , , 0.3, , , 0.4] },
      { id: 'impact-glass', name: 'Glass tap', zzfx: [0.9, , 1800, 0.001, 0.02, 0.18, 5, 3] },
      { id: 'impact-body', name: 'Body fall', zzfx: [1, , 95, 0.03, 0.1, 0.45, 2, 1.8] },
      { id: 'impact-sword', name: 'Sword clang', zzfx: [1.2, , 420, 0.002, 0.02, 0.28, 3, 2.8, , , , 0.15] },
      { id: 'impact-wood', name: 'Wood knock', zzfx: [1, , 180, 0.01, 0.05, 0.32, 2, 1.6] },
      { id: 'impact-rubber', name: 'Rubber slap', zzfx: [1.1, , 95, 0.02, 0.12, 0.38, 2, 2.2, -25] },
      { id: 'impact-gravel', name: 'Gravel hit', zzfx: [1.2, , 140, 0.01, 0.06, 0.32, 4, 1.8, , , , 0.55] },
      { id: 'impact-sand', name: 'Sand thump', zzfx: [0.95, , 110, 0.02, 0.1, 0.38, 3, 1.5, , , , 0.4] },
      { id: 'impact-ice', name: 'Ice crack', zzfx: [0.85, , 2000, 0.001, 0.025, 0.2, 5, 3, , , , 0.2] },
      { id: 'impact-bubble', name: 'Wet slap', zzfx: [1, , 160, 0.03, 0.14, 0.32, 3, 1.6, , , , 0.35] },
      { id: 'impact-ceramic', name: 'Ceramic clink', zzfx: [0.9, , 2400, 0.001, 0.015, 0.16, 5, 3.5] },
      { id: 'impact-chain', name: 'Chain rattle', zzfx: [1, , 280, 0.008, 0.04, 0.28, 4, 2.2, , , , 0.45] },
    ],
  },
  {
    id: 'explosions',
    label: 'Explosions',
    presets: [
      { id: 'ex-small', name: 'Small blast', zzfx: [1.3, , 55, 0.02, 0.25, 0.5, 3, 2, 0.5] },
      { id: 'ex-med', name: 'Medium blast', zzfx: [1.5, , 40, 0.03, 0.35, 0.65, 4, 2.5, 0.8] },
      { id: 'ex-noise', name: 'Noisy burst', zzfx: [1.2, , 70, 0.02, 0.2, 0.55, 4, 1, 2, 0, 0, 0, 0.6] },
      { id: 'ex-crunch', name: 'Crunch boom', zzfx: [1.4, , 65, 0.015, 0.15, 0.45, 3, 2.2, , , , 0.45] },
      { id: 'ex-electric', name: 'Electric pop', zzfx: [1.1, , 200, 0.002, 0.06, 0.22, 4, 3, , , , 0.5] },
      { id: 'ex-underwater', name: 'Muffled boom', zzfx: [1.2, , 45, 0.04, 0.4, 0.7, 3, 1.5, , , , 0.35] },
      { id: 'ex-spark', name: 'Spark burst', zzfx: [0.9, , 1200, 0.001, 0.04, 0.14, 5, 4, , , , 0.4] },
      { id: 'ex-tail', name: 'Long tail boom', zzfx: [1.2, , 48, 0.04, 0.5, 0.85, 3, 2, , , , 0.5] },
      { id: 'ex-compact', name: 'Compact burst', zzfx: [1.4, , 90, 0.008, 0.08, 0.22, 3, 2.5, , , , 0.25] },
      { id: 'ex-sizzle', name: 'Sizzle burst', zzfx: [1, , 180, 0.01, 0.12, 0.4, 4, 2, , , , 0.65] },
      { id: 'ex-ring', name: 'Shock ring', zzfx: [1.1, , 75, 0.02, 0.18, 0.55, 1, 2.2, 15] },
      { id: 'ex-flare', name: 'Flare pop', zzfx: [1.3, , 320, 0.003, 0.05, 0.2, 2, 3, -40] },
    ],
  },
  {
    id: 'pickups',
    label: 'Pickups & rewards',
    presets: [
      { id: 'coin', name: 'Coin', zzfx: [1, , 500, 0.01, 0.04, 0.15, 1, 0.6, , 3] },
      { id: 'powerup', name: 'Power-up', zzfx: [1.1, , 740, 0.02, 0.06, 0.22, 1, 1.8, -4, 4] },
      { id: 'heart', name: 'Heart / life', zzfx: [, , 537, 0.02, 0.02, 0.22, 1, 1.59, -6.98, 4.97] },
      { id: 'star', name: 'Star sparkle', zzfx: [0.9, , 1200, 0.005, 0.03, 0.2, 2, 2.5, , 8] },
      { id: 'level-up', name: 'Level up', zzfx: [1.2, , 400, 0.01, 0.1, 0.35, 1, 1.2, , 12, -0.2] },
      { id: 'gem', name: 'Gem', zzfx: [1, , 880, 0.003, 0.05, 0.18, 2, 2.2, , 10] },
      { id: 'key', name: 'Key / unlock', zzfx: [1.1, , 620, 0.008, 0.04, 0.2, 1, 1.6, 5] },
      { id: 'multi', name: 'Combo ping', zzfx: [1, , 700, 0.004, 0.03, 0.14, 1, 1.8, , 6] },
      { id: 'treasure', name: 'Treasure chest', zzfx: [1.2, , 280, 0.02, 0.1, 0.4, 2, 1.4, , 8] },
      { id: 'orb', name: 'Orb collect', zzfx: [1, , 720, 0.006, 0.05, 0.2, 2, 2, , 8] },
      { id: 'ring-collect', name: 'Ring collect', zzfx: [1.1, , 900, 0.004, 0.035, 0.16, 1, 1.9, , 5] },
      { id: 'bonus', name: 'Bonus wave', zzfx: [1.2, , 380, 0.02, 0.08, 0.35, 1, 1.6, , 14] },
      { id: 'streak', name: 'Streak tick', zzfx: [0.75, , 560, 0.002, 0.02, 0.09, 1, 1.3, , 4] },
      { id: 'magic-flourish', name: 'Magic flourish', zzfx: [1, , 520, 0.03, 0.12, 0.45, 2, 2.2, , 20] },
    ],
  },
  {
    id: 'alarms',
    label: 'Alarms & alerts',
    presets: [
      { id: 'alarm-fast', name: 'Fast beep', zzfx: [1, , 880, 0.005, 0.02, 0.08, 1, 1, , , , 120] },
      { id: 'alarm-slow', name: 'Slow alarm', zzfx: [1.1, , 220, 0.02, 0.15, 0.35, 1, 1, , , , 200] },
      { id: 'buzzer', name: 'Buzzer', zzfx: [1.2, , 150, 0.01, 0.2, 0.4, 2, 1, , , , 80] },
      { id: 'wrong', name: 'Wrong / error', zzfx: [1, , 180, 0.05, 0.1, 0.3, 1, 0.5, -8] },
      { id: 'alarm-urgent', name: 'Urgent pulse', zzfx: [1.2, , 440, 0.004, 0.03, 0.1, 1, 1, , , , 90] },
      { id: 'chime-soft', name: 'Soft chime', zzfx: [0.65, , 1320, 0.02, 0.1, 0.35, 0, 1.5, , , , 0.08] },
      { id: 'attention', name: 'Attention ding', zzfx: [1, , 770, 0.01, 0.05, 0.22, 1, 1.4, 3] },
      { id: 'countdown', name: 'Countdown tick', zzfx: [0.9, , 260, 0.008, 0.02, 0.1, 1, 1.1] },
    ],
  },
  {
    id: 'sci-fi',
    label: 'Sci‑fi',
    presets: [
      { id: 'laser', name: 'Laser shot', zzfx: [0.9, , 1200, 0.001, 0.06, 0.12, 3, 4, -50] },
      { id: 'laser-big', name: 'Heavy laser', zzfx: [1.2, , 180, 0.01, 0.08, 0.35, 3, 3, -20] },
      { id: 'warp', name: 'Warp', zzfx: [1, , 200, 0.05, 0.2, 0.6, 0, 2, 40, 0, 0, 0, 0.15] },
      { id: 'scanner', name: 'Scanner', zzfx: [0.7, , 800, 0.002, 0.04, 0.25, 1, 3, , 15] },
      { id: 'alien', name: 'Alien ping', zzfx: [1, , 400, 0.02, 0.12, 0.4, 4, 2.5, , 6] },
      { id: 'teleport', name: 'Teleport', zzfx: [1, , 300, 0.06, 0.25, 0.55, 0, 2.5, 180, , , , 0.2] },
      { id: 'shield', name: 'Shield hum', zzfx: [0.75, , 220, 0.08, 0.35, 0.5, 0, 1.2, , , , 150] },
      { id: 'charge', name: 'Charge up', zzfx: [1, , 90, 0.12, 0.45, 0.65, 0, 1.8, 220] },
      { id: 'hologram', name: 'Hologram flicker', zzfx: [0.6, , 1400, 0.002, 0.02, 0.12, 4, 3, , , , 0.25] },
      { id: 'drone-pass', name: 'Fly-by drone', zzfx: [0.8, , 95, 0.06, 0.25, 0.55, 0, 2, -60] },
      { id: 'servo', name: 'Servo motor', zzfx: [0.7, , 210, 0.04, 0.2, 0.45, 1, 1.5, , , , 120] },
      { id: 'plasma', name: 'Plasma hiss', zzfx: [0.85, , 350, 0.02, 0.15, 0.42, 4, 2.5, , , , 0.5] },
      { id: 'cpu-beep', name: 'CPU beep', zzfx: [0.55, , 2000, 0.002, 0.015, 0.08, 1, 1.2] },
      { id: 'datagram', name: 'Data blip', zzfx: [0.6, , 1600, 0.001, 0.012, 0.07, 3, 2.8, , , , 0.3] },
      { id: 'airlock', name: 'Airlock seal', zzfx: [1.1, , 60, 0.03, 0.2, 0.55, 3, 1.8, , , , 0.2] },
    ],
  },
  {
    id: 'cartoon',
    label: 'Cartoon',
    presets: [
      { id: 'boing', name: 'Boing', zzfx: [1.2, , 180, 0.02, 0.15, 0.45, 2, 3, -30, 2] },
      { id: 'pop', name: 'Pop', zzfx: [1, , 600, 0.005, 0.03, 0.12, 2, 2] },
      { id: 'slide', name: 'Slide whistle', zzfx: [1, , 300, 0.03, 0.2, 0.5, 0, 3, 80] },
      { id: 'squish', name: 'Squish', zzfx: [1.1, , 90, 0.04, 0.2, 0.35, 3, 1.5, , , , 0.5] },
      { id: 'bonk', name: 'Bonk', zzfx: [1.3, , 140, 0.008, 0.04, 0.28, 2, 2.5, -15] },
      { id: 'stretch', name: 'Stretch', zzfx: [1, , 120, 0.05, 0.25, 0.55, 0, 2.5, 95] },
      { id: 'whee', name: 'Whee up', zzfx: [1.1, , 200, 0.04, 0.18, 0.5, 0, 3, 150] },
      { id: 'zip', name: 'Zip', zzfx: [0.95, , 500, 0.02, 0.05, 0.18, 0, 2.5, 200] },
      { id: 'crunch-soft', name: 'Soft crunch', zzfx: [1, , 85, 0.02, 0.12, 0.38, 3, 1.7, , , , 0.45] },
      { id: 'spring', name: 'Spring', zzfx: [1.2, , 320, 0.015, 0.1, 0.38, 2, 3, -45, 2] },
    ],
  },
  {
    id: 'percussion',
    label: 'Drums & rhythm',
    presets: [
      { id: 'drum', name: 'Drum hit', zzfx: [, , 129, 0.01, , 0.15, , , , , , , 5] },
      { id: 'kick', name: 'Kick', zzfx: [1.3, , 55, 0.005, 0.02, 0.25, 3, 2] },
      { id: 'snare', name: 'Snare-ish', zzfx: [1, , 200, 0.002, 0.02, 0.15, 4, 2, , , , 0.35] },
      { id: 'hat', name: 'Hi-hat', zzfx: [0.6, , 8000, 0.001, 0.01, 0.05, 4, 4, , , , 0.8] },
      { id: 'tom', name: 'Tom', zzfx: [1.2, , 100, 0.008, 0.03, 0.35, 3, 2.2] },
      { id: 'clap', name: 'Clap', zzfx: [1, , 180, 0.002, 0.02, 0.18, 4, 2.5, , , , 0.5] },
      { id: 'rim', name: 'Rim shot', zzfx: [1.1, , 450, 0.001, 0.015, 0.12, 3, 2.8] },
      { id: 'ride', name: 'Ride bell', zzfx: [0.75, , 600, 0.003, 0.04, 0.22, 2, 2, , , , 0.15] },
      { id: 'shaker', name: 'Shaker', zzfx: [0.5, , 3000, 0.02, 0.08, 0.25, 4, 2, , , , 0.75] },
    ],
  },
  {
    id: 'transitions',
    label: 'Transitions',
    presets: [
      { id: 'whoosh', name: 'Whoosh', zzfx: [0.9, , 400, 0.08, 0.15, 0.55, 0, 2, 120] },
      { id: 'sweep-up', name: 'Sweep up', zzfx: [1, , 120, 0.1, 0.2, 0.45, 0, 2, 200] },
      { id: 'riser', name: 'Riser', zzfx: [1.1, , 80, 0.15, 0.35, 0.7, 0, 1.5, 150] },
      { id: 'downer', name: 'Downer', zzfx: [1, , 500, 0.05, 0.25, 0.55, 0, 2, -120] },
      { id: 'tape-stop', name: 'Tape stop', zzfx: [1, , 300, 0.02, 0.15, 0.45, 0, 2, -200] },
      { id: 'reverse-suck', name: 'Reverse suck', zzfx: [0.95, , 250, 0.1, 0.2, 0.5, 0, 2, -90] },
      { id: 'glitch-in', name: 'Glitch in', zzfx: [0.85, , 800, 0.01, 0.06, 0.22, 4, 3, , , , 0.55] },
      { id: 'glitch-out', name: 'Glitch out', zzfx: [0.85, , 600, 0.01, 0.08, 0.28, 4, 2.5, , , , 0.6] },
      { id: 'soft-in', name: 'Soft fade in', zzfx: [0.7, , 200, 0.15, 0.25, 0.5, 0, 1.2, 40] },
      { id: 'hard-cut', name: 'Hard cut', zzfx: [1.2, , 150, 0.001, 0.02, 0.08, 2, 2] },
    ],
  },
  {
    id: 'sfxr',
    label: 'Retro game',
    presets: [
      { id: 'sfxr-jump', name: 'Jump', zzfx: [1, , 300, 0.02, 0.05, 0.15, 0, 2, 50] },
      { id: 'sfxr-shoot', name: 'Shoot / pew', zzfx: [0.9, , 800, 0.001, 0.02, 0.1, 3, 3, -15] },
      { id: 'sfxr-hurt', name: 'Hurt', zzfx: [1.2, , 120, 0.01, 0.08, 0.25, 4, 1.5, , -20] },
      { id: 'sfxr-bling', name: 'Pickup bling', zzfx: [1, , 600, 0.005, 0.04, 0.12, 1, 2, 8] },
      { id: 'sfxr-tiny-pop', name: 'Tiny pop', zzfx: [0.8, , 400, 0.002, 0.03, 0.08, 2, 2] },
      { id: 'sfxr-stab', name: 'Synth stab', zzfx: [1.1, , 110, 0.01, 0.12, 0.3, 1, 1.8] },
      { id: 'sfxr-noise', name: 'Noise burst', zzfx: [1, , 100, 0.01, 0.1, 0.35, 4, 1, , , , 0.7] },
      { id: 'sfxr-tone', name: 'Simple tone', zzfx: [0.7, , 440, 0.05, 0.2, 0.25, 0, 1] },
      { id: 'sfxr-wobble', name: 'Wobble', zzfx: [1, , 200, 0.03, 0.15, 0.4, 2, 2, , , 90] },
      { id: 'sfxr-slide', name: 'Pitch slide', zzfx: [1, , 150, 0.05, 0.2, 0.5, 0, 2, 100] },
      { id: 'sfxr-zap', name: 'Zap', zzfx: [1.2, , 900, 0.001, 0.03, 0.1, 3, 4, -80] },
      { id: 'sfxr-thump', name: 'Land thump', zzfx: [1.3, , 70, 0.008, 0.03, 0.3, 3, 2.5] },
      { id: 'sfxr-8bit-run', name: '8-bit run', zzfx: [0.5, , 320, 0.002, 0.015, 0.06, 1, 1.2, , , 40] },
      { id: 'sfxr-game-start', name: 'Game start', zzfx: [1.2, , 200, 0.02, 0.15, 0.45, 1, 1.5, , 18] },
      { id: 'sfxr-powerdown', name: 'Power down', zzfx: [1, , 280, 0.04, 0.2, 0.55, 0, 1.5, -140] },
      { id: 'sfxr-laser-charge', name: 'Laser charge', zzfx: [0.9, , 120, 0.08, 0.35, 0.6, 0, 1.8, 180] },
      { id: 'sfxr-mutate', name: 'Mutate', zzfx: [1.1, , 160, 0.02, 0.12, 0.42, 4, 2, , , , 0.55] },
      { id: 'sfxr-lift', name: 'Lift / spring up', zzfx: [1, , 250, 0.02, 0.1, 0.38, 2, 2.8, 55] },
      { id: 'sfxr-coin-slot', name: 'Coin slot', zzfx: [1, , 480, 0.006, 0.04, 0.18, 3, 2.2] },
      { id: 'sfxr-enemy-die', name: 'Enemy poof', zzfx: [1.2, , 180, 0.015, 0.1, 0.35, 4, 2, , , , 0.4] },
      { id: 'sfxr-bubble', name: 'Bubble pop', zzfx: [0.85, , 650, 0.004, 0.03, 0.14, 2, 2] },
      { id: 'sfxr-motor', name: 'Motor loop-ish', zzfx: [0.6, , 95, 0.06, 0.3, 0.5, 1, 1.2, , , , 200] },
      { id: 'sfxr-blip-up', name: 'Blip up', zzfx: [1, , 380, 0.02, 0.06, 0.2, 0, 1.8, 90] },
      { id: 'sfxr-blip-down', name: 'Blip down', zzfx: [1, , 420, 0.02, 0.06, 0.2, 0, 1.6, -85] },
      { id: 'sfxr-double-jump', name: 'Double jump', zzfx: [1.1, , 380, 0.015, 0.04, 0.14, 0, 2.2, 70] },
    ],
  },
  {
    id: 'ambient',
    label: 'Ambient & drones',
    presets: [
      { id: 'amb-wind', name: 'Soft wind', zzfx: [0.35, , 180, 0.25, 0.55, 0.85, 3, 0.6, , , , 0.25] },
      { id: 'amb-pad', name: 'Warm pad', zzfx: [0.4, , 110, 0.15, 0.6, 0.9, 0, 1.1, , , , 0.12] },
      { id: 'amb-space', name: 'Space drone', zzfx: [0.3, , 55, 0.3, 0.7, 1.1, 0, 0.8, , , , 0.2] },
      { id: 'amb-rumble', name: 'Low rumble', zzfx: [0.55, , 40, 0.08, 0.45, 0.75, 3, 1.2, , , , 0.35] },
      { id: 'amb-crystal', name: 'Crystal bed', zzfx: [0.25, , 1200, 0.1, 0.4, 0.7, 2, 1.5, , , , 0.15] },
      { id: 'amb-pulse', name: 'Slow pulse', zzfx: [0.45, , 90, 0.2, 0.5, 0.8, 1, 1, , , , 180] },
      { id: 'amb-horror', name: 'Tense drone', zzfx: [0.4, , 70, 0.12, 0.55, 0.95, 4, 1.3, , , , 0.3] },
      { id: 'amb-rain', name: 'Rain texture', zzfx: [0.2, , 2400, 0.05, 0.2, 0.45, 4, 2, , , , 0.85] },
      { id: 'amb-dark', name: 'Dark hum', zzfx: [0.3, , 48, 0.2, 0.65, 1, 0, 0.85, , , , 0.25] },
      { id: 'amb-choir', name: 'Airy pad', zzfx: [0.28, , 280, 0.12, 0.55, 0.9, 0, 1, , , , 0.1] },
      { id: 'amb-glass', name: 'Glass tone bed', zzfx: [0.22, , 880, 0.15, 0.45, 0.75, 2, 1.6, , , , 0.12] },
      { id: 'amb-machine', name: 'Machine room', zzfx: [0.35, , 65, 0.1, 0.5, 0.85, 3, 1.1, , , , 0.4] },
    ],
  },
  {
    id: 'misc',
    label: 'Classic ZzFX demos',
    presets: [
      { id: 'game-over', name: 'Game over', zzfx: [, , 925, 0.04, 0.3, 0.6, 1, 0.3, , 6.27, -184, 0.09, 0.17] },
      { id: 'piano', name: 'Piano pluck', zzfx: [1.5, 0.8, 270, , 0.1, , 1, 1.5, , , , , , , , 0.1, 0.01] },
      { id: 'blip', name: 'Blip', zzfx: [1, , 999, 0.002, 0.02, 0.1, 0, 1.5] },
      { id: 'notify', name: 'Notification', zzfx: [1, , 660, 0.01, 0.06, 0.2, 1, 1.2, , 5] },
      { id: 'sparkle-short', name: 'Sparkle', zzfx: [0.9, , 1400, 0.003, 0.025, 0.14, 2, 2.5, , 15] },
      { id: 'digital-glitch', name: 'Digital glitch', zzfx: [0.75, , 600, 0.008, 0.04, 0.2, 4, 2.8, , , , 0.5] },
      { id: 'confirm-deep', name: 'Confirm deep', zzfx: [1.1, , 180, 0.02, 0.12, 0.4, 1, 1.5, -5] },
      { id: 'cancel-soft', name: 'Cancel soft', zzfx: [0.8, , 220, 0.04, 0.15, 0.38, 1, 0.7, -10] },
      { id: 'timer-done', name: 'Timer done', zzfx: [1.2, , 520, 0.01, 0.08, 0.3, 1, 1.3, , 8] },
      { id: 'typing', name: 'Typing burst', zzfx: [0.45, , 1400, 0.002, 0.01, 0.05, 4, 2.5, , , , 0.4] },
    ],
  },
] as ZzfxSfxCategory[]

/** Legacy export: category chips only */
export const SFX_LIBRARY_CATEGORIES: SfxBrowseCategory[] = ZZFX_SFX_CATEGORIES.map(({ id, label }) => ({
  id,
  label,
}))

export function getZzfxCategory(id: string | undefined | null): ZzfxSfxCategory | undefined {
  if (!id) return undefined
  return ZZFX_SFX_CATEGORIES.find((c) => c.id === id)
}

/** Flat list for search */
export function allZzfxPresetsFlat(): Array<ZzfxSfxPreset & { categoryId: string; categoryLabel: string }> {
  const out: Array<ZzfxSfxPreset & { categoryId: string; categoryLabel: string }> = []
  for (const cat of ZZFX_SFX_CATEGORIES) {
    for (const p of cat.presets) {
      out.push({ ...p, categoryId: cat.id, categoryLabel: cat.label })
    }
  }
  return out
}
