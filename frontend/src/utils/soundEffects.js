// Chess sound effects and haptic feedback utilities

// Sound URLs (using free chess sound effects - base64 encoded for reliability)
// These are minimal ~5kb sounds
const SOUNDS = {
  move: null,
  capture: null,
  check: null,
  gameStart: null,
  gameEnd: null,
};

// Initialize sounds with Web Audio API for better performance
let audioContext = null;

const initAudioContext = () => {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioContext;
};

// Simple tone generator for chess sounds (no external files needed)
const generateTone = (frequency, duration, type = 'sine', volume = 0.3) => {
  return new Promise((resolve) => {
    try {
      const ctx = initAudioContext();
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);
      
      oscillator.frequency.value = frequency;
      oscillator.type = type;
      gainNode.gain.setValueAtTime(volume, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
      
      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + duration);
      
      setTimeout(resolve, duration * 1000);
    } catch (e) {
      console.warn('Audio not available:', e);
      resolve();
    }
  });
};

// Sound effect functions
export const playMoveSound = async (soundEnabled = true) => {
  if (!soundEnabled) return;
  // Short wooden tap sound
  await generateTone(800, 0.08, 'sine', 0.2);
};

export const playCaptureSound = async (soundEnabled = true) => {
  if (!soundEnabled) return;
  // Slightly longer, lower pitched thud
  await generateTone(400, 0.12, 'triangle', 0.3);
  await generateTone(200, 0.08, 'sine', 0.2);
};

export const playCheckSound = async (soundEnabled = true) => {
  if (!soundEnabled) return;
  // Alert sound - two quick tones
  await generateTone(880, 0.1, 'sine', 0.25);
  await new Promise(r => setTimeout(r, 50));
  await generateTone(880, 0.1, 'sine', 0.25);
};

export const playGameStartSound = async (soundEnabled = true) => {
  if (!soundEnabled) return;
  // Pleasant ascending tone
  await generateTone(440, 0.1, 'sine', 0.2);
  await generateTone(554, 0.1, 'sine', 0.2);
  await generateTone(659, 0.15, 'sine', 0.25);
};

export const playGameEndSound = async (soundEnabled = true) => {
  if (!soundEnabled) return;
  // Descending tone for game end
  await generateTone(659, 0.15, 'sine', 0.25);
  await generateTone(554, 0.1, 'sine', 0.2);
  await generateTone(440, 0.2, 'sine', 0.2);
};

export const playOpponentJoinedSound = async (soundEnabled = true) => {
  if (!soundEnabled) return;
  // Notification sound
  await generateTone(523, 0.1, 'sine', 0.2);
  await generateTone(659, 0.15, 'sine', 0.25);
};

// Vibration functions
export const vibrate = (vibrationEnabled = true, pattern = 40) => {
  if (!vibrationEnabled) return;
  if ('vibrate' in navigator) {
    try {
      navigator.vibrate(pattern);
    } catch (e) {
      console.warn('Vibration not available:', e);
    }
  }
};

export const vibrateMove = (vibrationEnabled = true) => {
  vibrate(vibrationEnabled, 30);
};

export const vibrateCapture = (vibrationEnabled = true) => {
  vibrate(vibrationEnabled, [40, 30, 40]);
};

export const vibrateCheck = (vibrationEnabled = true) => {
  vibrate(vibrationEnabled, [50, 50, 50]);
};

export const vibrateGameStart = (vibrationEnabled = true) => {
  vibrate(vibrationEnabled, [100, 50, 100]);
};

// Settings storage
const SETTINGS_KEY = 'outpla_settings';

export const getSettings = () => {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.warn('Failed to load settings:', e);
  }
  return {
    soundEnabled: true,
    vibrationEnabled: true,
  };
};

export const saveSettings = (settings) => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn('Failed to save settings:', e);
  }
};

// Combined feedback function for moves
export const moveFeedback = async (moveType, settings) => {
  const { soundEnabled, vibrationEnabled } = settings || getSettings();
  
  switch (moveType) {
    case 'move':
      await playMoveSound(soundEnabled);
      vibrateMove(vibrationEnabled);
      break;
    case 'capture':
      await playCaptureSound(soundEnabled);
      vibrateCapture(vibrationEnabled);
      break;
    case 'check':
      await playCheckSound(soundEnabled);
      vibrateCheck(vibrationEnabled);
      break;
    case 'gameStart':
      await playGameStartSound(soundEnabled);
      vibrateGameStart(vibrationEnabled);
      break;
    case 'gameEnd':
      await playGameEndSound(soundEnabled);
      vibrate(vibrationEnabled, [100, 100, 200]);
      break;
    case 'opponentJoined':
      await playOpponentJoinedSound(soundEnabled);
      vibrateGameStart(vibrationEnabled);
      break;
    default:
      break;
  }
};
