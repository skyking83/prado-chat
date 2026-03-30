import React, { useState, useEffect, useRef, useCallback } from 'react'
import { io } from 'socket.io-client'
import Cropper from 'react-easy-crop'
import EmojiPicker from 'emoji-picker-react'
import VideoRoom from './VideoRoom'
import { googleFonts } from './googleFontsList'
import { 
  generateIdentityKeyPair, exportPublicKey, wrapPrivateKey, unwrapPrivateKey, 
  generateRoomKey, encryptRoomKeyWithPublicKey, decryptRoomKeyWithPrivateKey, 
  encryptMessage, decryptMessage, importPrivateKey,
  syncPrivateKeyToIDB, syncRoomKeyToIDB, purgeCryptoIDB
} from './crypto'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const devDomain = window.location.hostname;
const socketUrl = import.meta.env.MODE === 'production' ? '' : `http://${devDomain}:3001`;

// ─── E2EE Helpers ───────────────────────────────────────────
const isEncryptedSpace = (space) => space && space.name !== 'General';

async function tryDecryptMsg(text, aesKey) {
  if (!text || typeof text !== 'string') return { text, raw_text: null };
  if (!aesKey) return { text: '🔒 [Encrypted Message]', raw_text: text };
  try {
    return { text: await decryptMessage(text, aesKey), raw_text: null };
  } catch (e) {
    return { text: '🔒 [Decryption Failed]', raw_text: null };
  }
}

// Utility functions for dynamic modern material coloring
function getContrastColor(hex) {
  if (!hex || hex.length !== 7) return '#ffffff';
  let r = parseInt(hex.substring(1, 3), 16);
  let g = parseInt(hex.substring(3, 5), 16);
  let b = parseInt(hex.substring(5, 7), 16);
  let luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#000000' : '#ffffff';
}

function hexToRgb(hex) {
  if (!hex || hex.length !== 7 || hex[0] !== '#') return '208, 188, 255';
  let r = parseInt(hex.substring(1, 3), 16);
  let g = parseInt(hex.substring(3, 5), 16);
  let b = parseInt(hex.substring(5, 7), 16);
  return `${r}, ${g}, ${b}`;
}

// ─── Markdown Renderer ─────────────────────────────────────

// Configure marked for chat-style rendering
marked.setOptions({
  breaks: true,        // Convert \n to <br>
  gfm: true,           // GitHub Flavored Markdown (tables, strikethrough, etc.)
});

// Custom renderer to open links in new tabs
const renderer = new marked.Renderer();
renderer.link = ({ href, title, text }) => {
  const titleAttr = title ? ` title="${title}"` : '';
  return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer" style="color:var(--md-sys-color-primary);text-decoration:underline;word-break:break-all">${text}</a>`;
};

const renderMarkdown = (text) => {
  if (!text) return '';
  const rawHtml = marked.parse(text, { renderer });
  // Strip wrapping <p> tags for single-line messages to keep chat bubbles compact
  const trimmed = rawHtml.trim();
  const unwrapped = trimmed.startsWith('<p>') && trimmed.endsWith('</p>') && trimmed.indexOf('<p>', 1) === -1
    ? trimmed.slice(3, -4)
    : trimmed;
  return DOMPurify.sanitize(unwrapped, { ADD_ATTR: ['target'] });
};

// ─── ContentEditable Helpers ────────────────────────────────

// Serialize a contentEditable DOM tree back to markdown text
const serializeToMarkdown = (el) => {
  let out = '';
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      const inner = serializeToMarkdown(node);
      if (tag === 'strong' || tag === 'b') out += `**${inner}**`;
      else if (tag === 'em' || tag === 'i') out += `*${inner}*`;
      else if (tag === 'del' || tag === 's' || tag === 'strike') out += `~~${inner}~~`;
      else if (tag === 'code') out += '`' + inner + '`';
      else if (tag === 'br') out += '\n';
      else if (tag === 'div' || tag === 'p') {
        if (out && !out.endsWith('\n')) out += '\n';
        out += inner;
      } else out += inner;
    }
  }
  return out;
};

// Auto-detect completed markdown patterns and replace with DOM formatting
const processMarkdownShortcuts = (el) => {
  const sel = window.getSelection();
  if (!sel.rangeCount) return false;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return false;
  const textNode = range.startContainer;
  if (textNode.nodeType !== Node.TEXT_NODE) return false;
  const text = textNode.textContent;
  const cursor = range.startOffset;
  const before = text.slice(0, cursor);

  const patterns = [
    { re: /\*\*(.+?)\*\*$/, tag: 'strong' },
    { re: /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*$/, tag: 'em' },
    { re: /~~(.+?)~~$/, tag: 'del' },
    { re: /`([^`]+)`$/, tag: 'code' },
  ];

  for (const { re, tag } of patterns) {
    const m = before.match(re);
    if (m) {
      const fullMatch = m[0];
      const innerText = m[1];
      const matchStart = m.index;
      const matchEnd = matchStart + fullMatch.length;
      const afterCursor = text.slice(cursor);

      // Split the text node: [before-match] [formatted] [after-cursor]
      const beforeText = text.slice(0, matchStart);
      const formatted = document.createElement(tag);
      formatted.textContent = innerText;

      const parent = textNode.parentNode;
      if (beforeText) parent.insertBefore(document.createTextNode(beforeText), textNode);
      parent.insertBefore(formatted, textNode);
      // Insert a zero-width space after so caret can leave the element
      const afterNode = document.createTextNode(afterCursor || '\u200B');
      parent.insertBefore(afterNode, textNode);
      parent.removeChild(textNode);

      // Place cursor after the formatted element
      const newRange = document.createRange();
      newRange.setStart(afterNode, afterCursor ? 0 : 1);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);
      return true;
    }
  }
  return false;
};

// Process ALL text nodes for markdown patterns (used after paste)
const processAllMarkdownInNode = (el) => {
  const patterns = [
    { re: /\*\*(.+?)\*\*/, tag: 'strong' },
    { re: /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/, tag: 'em' },
    { re: /~~(.+?)~~/, tag: 'del' },
    { re: /`([^`]+)`/, tag: 'code' },
  ];
  let changed = true;
  let iterations = 0;
  while (changed && iterations < 50) {
    changed = false;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while (node = walker.nextNode()) {
      // Skip nodes inside already-formatted elements
      if (node.parentNode !== el && ['STRONG','B','EM','I','DEL','S','CODE'].includes(node.parentNode.tagName)) continue;
      const text = node.textContent;
      for (const { re, tag } of patterns) {
        const m = text.match(re);
        if (m) {
          const matchStart = m.index;
          const beforeText = text.slice(0, matchStart);
          const afterText = text.slice(matchStart + m[0].length);
          const formatted = document.createElement(tag);
          formatted.textContent = m[1];
          const parent = node.parentNode;
          if (beforeText) parent.insertBefore(document.createTextNode(beforeText), node);
          parent.insertBefore(formatted, node);
          if (afterText) parent.insertBefore(document.createTextNode(afterText), node);
          parent.removeChild(node);
          changed = true;
          break;
        }
      }
      if (changed) break; // restart walker since DOM changed
    }
    iterations++;
  }
};

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/\-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/** Helper to crop image using canvas */
const getCroppedImg = (imageSrc, pixelCrop) => {
  const image = new Image();
  image.src = imageSrc;
  return new Promise((resolve) => {
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = pixelCrop.width;
      canvas.height = pixelCrop.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(
        image,
        pixelCrop.x,
        pixelCrop.y,
        pixelCrop.width,
        pixelCrop.height,
        0,
        0,
        pixelCrop.width,
        pixelCrop.height
      );
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
  });
};

const AvatarCropper = ({ image, onComplete, onCancel }) => {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState(null);

  return (
    <div className="cropper-overlay">
      <div className="cropper-container">
        <h2 style={{ margin: '0 0 1rem 0' }}>Crop Your Avatar</h2>
        <div className="cropper-wrapper">
          <Cropper
            image={image}
            crop={crop}
            zoom={zoom}
            aspect={1}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={(_, pixels) => setCroppedAreaPixels(pixels)}
          />
        </div>
        <div className="cropper-controls">
          <label style={{ fontSize: '0.9rem', color: 'var(--md-sys-color-outline)' }}>Zoom</label>
          <input
            type="range"
            value={zoom}
            min={1}
            max={3}
            step={0.1}
            onChange={(e) => setZoom(parseFloat(e.target.value))}
            className="zoom-range"
          />
          <div className="cropper-btns">
            <button onClick={onCancel} className="btn-secondary">Cancel</button>
            <button onClick={async () => onComplete(await getCroppedImg(image, croppedAreaPixels))} className="btn-primary">Save Avatar</button>
          </div>
        </div>
      </div>
    </div>
  );
};

const VideoMessage = ({ src }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const devDomain = window.location.hostname;
  const socketUrl = import.meta.env.MODE === 'production' ? '' : `http://${devDomain}:3001`;
  const fullSrc = src.startsWith('/uploads/') ? `${socketUrl}${src}` : src;

  if (isPlaying) {
    return (
      <video
        src={fullSrc}
        className="video-player"
        controls
        autoPlay
        playsInline
      />
    );
  }

  return (
    <div className="video-container" onClick={() => setIsPlaying(true)}>
      <video src={`${fullSrc}#t=0.001`} className="video-thumbnail" preload="metadata" playsInline muted />
      <div className="play-overlay">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z" />
        </svg>
      </div>
    </div>
  );
};

const FontPicker = ({ value, onApply }) => {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [currentSelected, setCurrentSelected] = useState(value || 'Inter');
  const observerRef = useRef(null);

  useEffect(() => {
    setCurrentSelected(value || 'Inter');
  }, [value]);

  useEffect(() => {
    if (currentSelected) {
      const fontName = currentSelected.replace(/ /g, '+');
      const linkId = `preview-input-${fontName.replace(/[^a-zA-Z]/g, '')}`;
      if (!document.getElementById(linkId)) {
        const link = document.createElement('link');
        link.id = linkId;
        link.rel = 'stylesheet';
        link.href = `https://fonts.googleapis.com/css2?family=${fontName}&text=${encodeURIComponent(currentSelected + ' aA')}&display=swap`;
        document.head.appendChild(link);
      }
    }
  }, [currentSelected]);

  const popularFonts = ['Roboto', 'Open Sans', 'Montserrat', 'Lato', 'Poppins', 'Inter', 'Oswald', 'Raleway', 'Noto Sans', 'Nunito'];
  const popularMatches = popularFonts.filter(f => f.toLowerCase().includes(query.toLowerCase()));
  const otherMatches = googleFonts.filter(f => !popularFonts.includes(f) && f.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => {
    observerRef.current = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const font = entry.target.dataset.font;
          const fontName = font.replace(/ /g, '+');
          const linkId = `preview-${fontName.replace(/[^a-zA-Z]/g, '')}`;
          if (!document.getElementById(linkId)) {
            const link = document.createElement('link');
            link.id = linkId;
            link.rel = 'stylesheet';
            link.href = `https://fonts.googleapis.com/css2?family=${fontName}&text=${encodeURIComponent(font + ' aA')}&display=swap`;
            document.head.appendChild(link);
          }
          entry.target.style.fontFamily = `'${font}', sans-serif`;
          observerRef.current.unobserve(entry.target);
        }
      });
    }, { rootMargin: '100px' });

    return () => {
      if (observerRef.current) observerRef.current.disconnect();
    };
  }, []);

  return (
    <div style={{ position: 'relative', width: '100%', maxWidth: '400px' }}>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <input 
          type="text"
          value={isOpen ? query : currentSelected}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => { setIsOpen(true); setQuery(''); }}
          onBlur={() => setTimeout(() => { setIsOpen(false); setQuery(''); }, 200)}
          placeholder="Search 1,500+ fonts..."
          style={{ 
            flex: 1, padding: '0.75rem', backgroundColor: 'var(--md-sys-color-surface-variant)', 
            color: 'var(--md-sys-color-on-surface)', border: 'none', borderRadius: '4px', fontSize: '1rem',
            fontFamily: query ? 'inherit' : `'${currentSelected}', sans-serif`
          }}
        />
        <button 
          onClick={() => { setIsOpen(false); onApply(currentSelected); }}
          className="btn-primary"
          style={{ padding: '0.75rem 1.5rem', borderRadius: '4px' }}
        >
          Apply
        </button>
      </div>

      {isOpen && (popularMatches.length > 0 || otherMatches.length > 0) && (
        <ul style={{ 
          position: 'absolute', bottom: 'calc(100% + 4px)', top: 'auto', left: 0, width: 'calc(100% - 90px)', 
          maxHeight: '220px', overflowY: 'auto', backgroundColor: 'var(--md-sys-color-surface-container-high)', 
          border: '1px solid var(--md-sys-color-outline)', borderRadius: '4px', zIndex: 10, listStyle: 'none', padding: 0, margin: 0,
          boxShadow: 'var(--elevation-3)'
        }}>
          {popularMatches.length > 0 && (
            <>
              <li style={{ padding: '0.25rem 0.75rem', fontSize: '0.65rem', fontWeight: 'bold', color: 'var(--md-sys-color-primary)', textTransform: 'uppercase', letterSpacing: '0.5px', backgroundColor: 'var(--md-sys-color-surface-variant)' }}>Popular</li>
              {popularMatches.map(font => (
                <li 
                  key={`pop-${font}`}
                  data-font={font}
                  ref={(el) => { if (el && observerRef.current) observerRef.current.observe(el); }}
                  onMouseDown={(e) => { e.preventDefault(); setCurrentSelected(font); setIsOpen(false); }}
                  style={{ padding: '0.35rem 0.75rem', cursor: 'pointer', fontSize: '1rem', borderBottom: '1px solid var(--md-sys-color-outline-variant)' }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--md-sys-color-surface-variant)'}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                >
                  {font}
                </li>
              ))}
            </>
          )}
          {otherMatches.length > 0 && (
            <>
              {popularMatches.length > 0 && <li style={{ height: '1px', backgroundColor: 'var(--md-sys-color-outline)', margin: '4px 0' }}></li>}
              <li style={{ padding: '0.25rem 0.75rem', fontSize: '0.65rem', fontWeight: 'bold', color: 'var(--md-sys-color-on-surface-variant)', textTransform: 'uppercase', letterSpacing: '0.5px', backgroundColor: 'var(--md-sys-color-surface-variant)' }}>All Fonts</li>
              {otherMatches.map(font => (
                <li 
                  key={font}
                  data-font={font}
                  ref={(el) => { if (el && observerRef.current) observerRef.current.observe(el); }}
                  onMouseDown={(e) => { e.preventDefault(); setCurrentSelected(font); setIsOpen(false); }}
                  style={{ padding: '0.35rem 0.75rem', cursor: 'pointer', fontSize: '1rem', borderBottom: '1px solid var(--md-sys-color-outline-variant)' }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--md-sys-color-surface-variant)'}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                >
                  {font}
                </li>
              ))}
            </>
          )}
        </ul>
      )}
    </div>
  );
};
const WeatherIcon = ({ type }) => {
  const props = { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", style: { flexShrink: 0 } };
  switch(type) {
    case 'sun': return <svg {...props}><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>;
    case 'moon': return <svg {...props}><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path></svg>;
    case 'cloud-sun': return <svg {...props}><path d="M12 2v2"></path><path d="m4.93 4.93 1.41 1.41"></path><path d="M20 12h2"></path><path d="m19.07 4.93-1.41 1.41"></path><path d="M15.947 8.688A5 5 0 0 0 7.05 11.233 4.5 4.5 0 0 0 7.5 20h9a5 5 0 0 0-1.053-11.312Z"></path></svg>;
    case 'cloud-moon': return <svg {...props}><path d="M10.188 8.465a4.323 4.323 0 0 1 3.2 0 4.246 4.246 0 0 0 2.228 3.033A5 5 0 1 1 7.5 20h9a5 5 0 1 0-1.812-9.535Z"></path></svg>;
    case 'cloud': return <svg {...props}><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"></path></svg>;
    case 'fog': return <svg {...props}><line x1="8" y1="6" x2="21" y2="6"></line><line x1="3" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="5" y2="6"></line><line x1="3" y1="18" x2="5" y2="18"></line></svg>;
    case 'rain': return <svg {...props}><path d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25"></path><line x1="16" y1="13" x2="16" y2="21"></line><line x1="8" y1="13" x2="8" y2="21"></line><line x1="12" y1="15" x2="12" y2="23"></line></svg>;
    case 'snow': return <svg {...props}><line x1="12" y1="2" x2="12" y2="22"></line><line x1="5" y1="19" x2="19" y2="5"></line><line x1="5" y1="5" x2="19" y2="19"></line><line x1="10" y1="4" x2="12" y2="2"></line><line x1="14" y1="4" x2="12" y2="2"></line><line x1="10" y1="20" x2="12" y2="22"></line><line x1="14" y1="20" x2="12" y2="22"></line></svg>;
    case 'storm': return <svg {...props}><path d="M19 16.9A5 5 0 0 0 18 7h-1.26a8 8 0 1 0-11.62 9"></path><polyline points="13 11 9 17 15 17 11 23"></polyline></svg>;
    default: return <svg {...props}><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"></path></svg>;
  }
};
const useWeather = (location) => {
  const [weather, setWeather] = useState(null);
  useEffect(() => {
    if (!location || location.trim().length < 2) { setWeather(null); return; }
    const fetchWeather = async () => {
      try {
        const searchTerm = location.split(',')[0].trim();
        const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(searchTerm)}&count=1`);
        const geoData = await geoRes.json();
        if (!geoData.results || geoData.results.length === 0) return;
        const { latitude, longitude } = geoData.results[0];
        const wRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true&temperature_unit=fahrenheit`);
        const wData = await wRes.json();
        if (wData.current_weather) {
          const code = wData.current_weather.weathercode;
          const isDay = wData.current_weather.is_day;
          let icon = 'cloud';
          if (code === 0) icon = isDay ? 'sun' : 'moon';
          else if (code === 1) icon = isDay ? 'sun' : 'moon'; // Mainly clear
          else if (code === 2) icon = isDay ? 'cloud-sun' : 'cloud-moon'; // Partly cloudy
          else if (code === 3) icon = 'cloud'; // Overcast
          else if (code >= 45 && code <= 48) icon = 'fog';
          else if (code >= 51 && code <= 67) icon = 'rain';
          else if (code >= 71 && code <= 77) icon = 'snow';
          else if (code >= 80 && code <= 82) icon = 'rain';
          else if (code >= 95) icon = 'storm';
          setWeather({ temp: Math.round(wData.current_weather.temperature), icon });
        }
      } catch(err) { console.error('Weather fetch error:', err); }
    };
    fetchWeather();
    const interval = setInterval(fetchWeather, 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, [location]);
  return weather;
};

const AdminPanel = ({ socket, token, socketUrl, onClose, globalFont, currentUserId, onSelfUpdate, onPreviewAsset }) => {
  const [activeTab, setActiveTab] = useState('users');
  const [users, setUsers] = useState([]);
  const [assets, setAssets] = useState([]);
  const [spaces, setSpaces] = useState([]);
  const [editingUser, setEditingUser] = useState(null);
  const [adminCroppingImage, setAdminCroppingImage] = useState(null);
  const [locSuggestions, setLocSuggestions] = useState([]);
  const [showLocSuggestions, setShowLocSuggestions] = useState(false);
  const locTimeoutRef = useRef(null);
  const [adminResetPw, setAdminResetPw] = useState('');
  const [adminResetMsg, setAdminResetMsg] = useState(null);
  const [userToDelete, setUserToDelete] = useState(null);
  const [assetToDelete, setAssetToDelete] = useState(null);
  const [spaceToDeleteAdmin, setSpaceToDeleteAdmin] = useState(null);
  const [activeAdminMenu, setActiveAdminMenu] = useState(null); // { type: 'users'|'assets'|'spaces', id: string|number }
  const [typeFilter, setTypeFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [creatorFilter, setCreatorFilter] = useState('');
  const [sortConfig, setSortConfig] = useState(null);

  const requestSort = (key) => {
    let direction = 'ascending';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'ascending') {
      direction = 'descending';
    }
    setSortConfig({ key, direction });
  };

  const fetchLocSuggestions = async (query) => {
    if (!query || query.trim().length < 2) {
      setLocSuggestions([]);
      return;
    }
    try {
      const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=en`);
      if (res.ok) {
        const data = await res.json();
        if (!data.results) { setLocSuggestions([]); return; }
        const suggestions = data.results.map(f => {
          const parts = [f.name, f.admin1, f.country].filter(Boolean);
          return parts.join(', ');
        });
        setLocSuggestions([...new Set(suggestions)]);
      }
    } catch (err) { console.error('Geocoding search error:', err); }
  };

  const handleLocChange = (val) => {
    setEditingUser({ ...editingUser, location: val });
    setShowLocSuggestions(true);
    if (locTimeoutRef.current) clearTimeout(locTimeoutRef.current);
    locTimeoutRef.current = setTimeout(() => fetchLocSuggestions(val), 400);
  };

  useEffect(() => {
    const fetchData = async () => {
      try {
        const headers = { 'Authorization': `Bearer ${token}` };
        if (activeTab === 'users') {
          const res = await fetch(`${socketUrl}/api/admin/users`, { headers });
          if (res.ok) setUsers(await res.json());
        } else if (activeTab === 'assets') {
          const res = await fetch(`${socketUrl}/api/admin/assets`, { headers });
          if (res.ok) setAssets(await res.json());
        } else if (activeTab === 'spaces') {
          const res = await fetch(`${socketUrl}/api/spaces`, { headers });
          if (res.ok) setSpaces(await res.json());
        }
      } catch (err) { console.error(err); }
    };
    fetchData();
  }, [activeTab, token, socketUrl]);

  useEffect(() => {
    if (!socket) return;
    const onAssetDeleted = (filename) => {
      setAssets(prev => prev.filter(a => a.file !== filename));
    };
    socket.on('asset deleted', onAssetDeleted);
    return () => socket.off('asset deleted', onAssetDeleted);
  }, [socket]);

  const changeRole = async (id, newRole) => {
    await fetch(`${socketUrl}/api/admin/users/${id}/role`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ role: newRole })
    });
    setUsers(users.map(u => u.id === id ? { ...u, role: newRole } : u));
  };

  const deleteUser = async (id) => {
    const res = await fetch(`${socketUrl}/api/admin/users/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
    if (res.ok) {
      setUsers(users.filter(u => u.id !== id));
      setUserToDelete(null);
    } else { const data = await res.json(); alert(data.error); }
  };

  const deleteAsset = async (filename) => {
    const res = await fetch(`${socketUrl}/api/admin/assets/${filename}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
    if (res.ok) {
      setAssets(assets.filter(a => a.file !== filename));
      setAssetToDelete(null);
    } else { const data = await res.json(); alert(data.error); }
  };
  
  const deleteSpace = async (id) => {
    const res = await fetch(`${socketUrl}/api/admin/spaces/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
    if (res.ok) {
      setSpaces(spaces.filter(s => s.id !== id));
      setSpaceToDeleteAdmin(null);
    } else { const data = await res.json(); alert(data.error); }
  };


  const handleUserUpdate = async (e) => {
    e.preventDefault();
    const res = await fetch(`${socketUrl}/api/admin/users/${editingUser.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(editingUser)
    });
    if (res.ok) {
      setUsers(users.map(u => u.id === editingUser.id ? editingUser : u));
      onSelfUpdate();
      setEditingUser(null);
    } else {
      const data = await res.json();
      alert(data.error);
    }
  };

  const handleAdminResetPassword = async () => {
    if (!adminResetPw) return;
    if (!window.confirm(`Reset password for ${editingUser.first_name ? editingUser.first_name + ' ' + (editingUser.last_name || '') : editingUser.username}?`)) return;
    const res = await fetch(`${socketUrl}/api/admin/users/${editingUser.id}/password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ newPassword: adminResetPw })
    });
    const data = await res.json();
    setAdminResetMsg({ ok: res.ok, text: res.ok ? 'Password reset successfully' : data.error });
    if (res.ok) setAdminResetPw('');
    setTimeout(() => setAdminResetMsg(null), 3000);
  };

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'var(--md-sys-color-background)', zIndex: 9000, overflowY: 'auto', padding: 'min(5vw, 2rem)' }}>
      <div style={{ maxWidth: 'min(95vw, 1200px)', margin: '0 auto' }}>
        <h1 style={{ color: 'var(--md-sys-color-on-background)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          Admin Panel 
          <button onClick={onClose} className="icon-btn" title="Close" style={{ backgroundColor: 'var(--md-sys-color-surface-variant)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </h1>
        <div style={{ display: 'flex', gap: '1rem', borderBottom: '1px solid var(--md-sys-color-outline)', marginBottom: '1rem' }}>
          {['users', 'assets', 'spaces'].map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} style={{ background: 'none', border: 'none', padding: '0.5rem 1rem', cursor: 'pointer', color: activeTab === tab ? 'var(--md-sys-color-primary)' : 'var(--md-sys-color-on-surface-variant)', borderBottom: activeTab === tab ? '2px solid var(--md-sys-color-primary)' : 'none', fontWeight: activeTab === tab ? 'bold' : 'normal' }}>
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {activeTab === 'users' && !editingUser && (
          <div className="table-container">
            <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <label style={{ color: 'var(--md-sys-color-on-surface-variant)', fontSize: '0.9rem', fontWeight: 500 }}>Filter Role:</label>
              <select 
                value={roleFilter} 
                onChange={(e) => setRoleFilter(e.target.value)}
                style={{ padding: '0.4rem 0.75rem', borderRadius: '8px', border: '1px solid var(--md-sys-color-outline-variant)', backgroundColor: 'var(--md-sys-color-surface)', color: 'var(--md-sys-color-on-surface)', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
              >
                <option value="">All Users</option>
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <table className="admin-table">
            <thead>
              <tr>
                <th onClick={() => requestSort('first_name')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                  Name {sortConfig?.key === 'first_name' ? (sortConfig.direction === 'ascending' ? '↑' : '↓') : ''}
                </th>
                <th onClick={() => requestSort('role')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                  Role {sortConfig?.key === 'role' ? (sortConfig.direction === 'ascending' ? '↑' : '↓') : ''}
                </th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {[...users].filter(u => !roleFilter || u.role === roleFilter).sort((a, b) => {
                if (!sortConfig) return 0;
                let valA = a[sortConfig.key] || '';
                let valB = b[sortConfig.key] || '';
                if (sortConfig.key === 'id') {
                  valA = Number(valA);
                  valB = Number(valB);
                } else {
                  valA = String(valA).toLowerCase();
                  valB = String(valB).toLowerCase();
                }
                if (valA < valB) return sortConfig.direction === 'ascending' ? -1 : 1;
                if (valA > valB) return sortConfig.direction === 'ascending' ? 1 : -1;
                return 0;
              }).map(u => (
                <tr key={u.id}>
                  <td>{u.first_name} {u.last_name}</td>
                  <td>
                    <span style={{ padding: '4px 8px', borderRadius: '4px', backgroundColor: u.role === 'admin' ? 'var(--md-sys-color-primary-container)' : 'var(--md-sys-color-surface-variant)', color: u.role === 'admin' ? 'var(--md-sys-color-on-primary-container)' : 'var(--md-sys-color-on-surface-variant)', fontSize: '0.8rem', fontWeight: 'bold' }}>
                      {u.role.toUpperCase()}
                    </span>
                  </td>
                  <td className="admin-actions-cell">
                    <div className="admin-actions-desktop">
                      <button onClick={() => setEditingUser(u)} className="icon-btn" title="Edit Profile">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                      </button>
                      <button onClick={() => setUserToDelete(u)} className="icon-btn danger" title="Delete">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                      </button>
                    </div>
                    <div className="admin-actions-mobile">
                      <button className="action-menu-trigger" onClick={() => setActiveAdminMenu(activeAdminMenu?.id === u.id ? null : { type: 'users', id: u.id })}>⋮</button>
                      {activeAdminMenu?.type === 'users' && activeAdminMenu?.id === u.id && (
                        <div className="admin-actions-dropdown">
                          <button onClick={() => { setEditingUser(u); setActiveAdminMenu(null); }}>Edit Profile</button>
                          <button onClick={() => { setUserToDelete(u); setActiveAdminMenu(null); }} className="danger">Delete</button>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}

        {activeTab === 'users' && editingUser && (
          <form onSubmit={handleUserUpdate} style={{ backgroundColor: 'var(--md-sys-color-surface)', padding: 'min(5vw, 2rem)', borderRadius: '12px', border: '1px solid var(--md-sys-color-outline-variant)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2rem', alignItems: 'center' }}>
              <h2 style={{ color: 'var(--md-sys-color-on-surface)', margin: 0 }}>Edit User: {editingUser.first_name} {editingUser.last_name}</h2>
              <button type="button" onClick={() => setEditingUser(null)} className="btn-secondary">Cancel</button>
            </div>

            <div className="form-grid">

              <div className="form-group">
                <label>Role</label>
                <select 
                  value={editingUser.role} 
                  onChange={(e) => setEditingUser({...editingUser, role: e.target.value})}
                  style={{ padding: '0.85rem', backgroundColor: 'var(--md-sys-color-surface-variant)', color: 'var(--md-sys-color-on-surface)', border: 'none', borderRadius: '4px' }}
                >
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div className="form-group">
                <label>First Name</label>
                <input 
                  type="text" 
                  value={editingUser.first_name || ''} 
                  onChange={(e) => setEditingUser({...editingUser, first_name: e.target.value})}
                />
              </div>
              <div className="form-group">
                <label>Last Name</label>
                <input 
                  type="text" 
                  value={editingUser.last_name || ''} 
                  onChange={(e) => setEditingUser({...editingUser, last_name: e.target.value})}
                />
              </div>
              <div className="form-group">
                <label>Email</label>
                <input 
                  type="email" 
                  value={editingUser.email || ''} 
                  onChange={(e) => setEditingUser({...editingUser, email: e.target.value})}
                />
              </div>
              <div className="form-group">
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 'bold', marginBottom: '0.5rem', color: 'var(--md-sys-color-outline)' }}>User Avatar</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  {editingUser.avatar ? (
                    <img src={editingUser.avatar} style={{ width: '48px', height: '48px', borderRadius: '50%', objectFit: 'cover', border: '2px solid var(--md-sys-color-primary)' }} alt="Avatar" />
                  ) : (
                    <div style={{ width: '48px', height: '48px', borderRadius: '50%', backgroundColor: 'var(--md-sys-color-surface-variant)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--md-sys-color-on-background)', fontSize: '1rem', fontWeight: 'bold' }}>
                      {editingUser.username?.[0]?.toUpperCase() || '?'}
                    </div>
                  )}
                  <label style={{ width: '36px', height: '36px', borderRadius: '50%', backgroundColor: 'var(--md-sys-color-secondary-container)', color: 'var(--md-sys-color-on-secondary-container)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, transition: 'transform 0.2s', border: '1px solid var(--md-sys-color-outline-variant)' }} title="Upload Image">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                    <input type="file" accept="image/*" style={{ display: 'none' }} onClick={(e) => { e.target.value = null; }} onChange={(e) => {
                      const file = e.target.files[0];
                      if(file) {
                        const reader = new FileReader();
                        reader.onload = (event) => setAdminCroppingImage(event.target.result);
                        reader.readAsDataURL(file);
                      }
                    }} />
                  </label>
                  {editingUser.avatar && (
                    <button type="button" className="action-menu-trigger" onClick={() => setEditingUser({...editingUser, avatar: null})} style={{ padding: '0.5rem' }}>🗑️</button>
                  )}
                </div>
              </div>
              <div className="form-group" style={{ position: 'relative', zIndex: showLocSuggestions ? 10 : 1 }}>
                <label>Location</label>
                <input 
                  type="text" 
                  value={editingUser.location || ''} 
                  onChange={(e) => handleLocChange(e.target.value)}
                  onFocus={() => { if (editingUser.location?.length >= 2) setShowLocSuggestions(true); }}
                  onBlur={() => setTimeout(() => setShowLocSuggestions(false), 200)}
                  placeholder="City, Zip, or Country"
                />
                {showLocSuggestions && locSuggestions.length > 0 && (
                  <div className="location-suggestions">
                    {locSuggestions.map((s, idx) => (
                      <div 
                        key={idx} 
                        className="suggestion-item"
                        onClick={() => {
                          setEditingUser({ ...editingUser, location: s });
                          setShowLocSuggestions(false);
                        }}
                      >
                        {s}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ gridColumn: '1 / -1', marginTop: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 'bold', marginBottom: '0.5rem', color: 'var(--md-sys-color-outline)' }}>Primary User Font</label>
                <FontPicker value={editingUser.font_family || 'Inter'} onApply={(val) => setEditingUser({ ...editingUser, font_family: val })} />
              </div>
            </div>

            <div style={{ marginTop: '1.5rem', padding: 'min(4vw, 1.25rem)', backgroundColor: 'var(--md-sys-color-surface-variant)', borderRadius: '12px', border: '1px solid var(--md-sys-color-outline-variant)' }}>
              <h3 style={{ margin: '0 0 1rem', color: 'var(--md-sys-color-on-surface-variant)', fontSize: '0.9rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Reset Password</h3>
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div className="form-group" style={{ flex: 1, gap: '4px' }}>
                  <label style={{ fontSize: '0.75rem' }}>New Password</label>
                  <input
                    type="password"
                    placeholder="Min 6 characters"
                    value={adminResetPw}
                    onChange={(e) => { setAdminResetPw(e.target.value); setAdminResetMsg(null); }}
                  />
                </div>
                <button type="button" onClick={handleAdminResetPassword} className="btn-secondary" style={{ whiteSpace: 'nowrap', height: '42px', borderRadius: '8px' }}>Set Password</button>
              </div>
              {adminResetMsg && (
                <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: adminResetMsg.ok ? 'var(--md-sys-color-primary)' : 'var(--md-sys-color-error)' }}>
                  {adminResetMsg.text}
                </p>
              )}
            </div>

            <div style={{ marginTop: '2rem', display: 'flex', gap: '1rem' }}>
              <button type="submit" className="btn-primary" style={{ flex: 1 }}>Save Changes</button>
              <button type="button" onClick={() => { setEditingUser(null); setAdminResetPw(''); setAdminResetMsg(null); }} className="btn-secondary" style={{ flex: 1 }}>Discard</button>
            </div>
          </form>
        )}

        {activeTab === 'assets' && (
          <div className="table-container">
            <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <label style={{ color: 'var(--md-sys-color-on-surface-variant)', fontSize: '0.9rem', fontWeight: 500 }}>Filter Types:</label>
              <select 
                value={typeFilter} 
                onChange={(e) => setTypeFilter(e.target.value)}
                style={{ padding: '0.4rem 0.75rem', borderRadius: '8px', border: '1px solid var(--md-sys-color-outline-variant)', backgroundColor: 'var(--md-sys-color-surface)', color: 'var(--md-sys-color-on-surface)', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
              >
                <option value="">All Files</option>
                <option value="image">Images</option>
                <option value="video">Videos</option>
                <option value="other">Documents / Other</option>
              </select>
            </div>
            <table className="admin-table">
            <thead>
              <tr>
                <th style={{ width: '64px', textAlign: 'center' }}>Preview</th>
                <th onClick={() => requestSort('file')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                  Filename {sortConfig?.key === 'file' ? (sortConfig.direction === 'ascending' ? '↑' : '↓') : ''}
                </th>
                <th onClick={() => requestSort('type')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                  File Type {sortConfig?.key === 'type' ? (sortConfig.direction === 'ascending' ? '↑' : '↓') : ''}
                </th>
                <th onClick={() => requestSort('size')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                  Size (KB) {sortConfig?.key === 'size' ? (sortConfig.direction === 'ascending' ? '↑' : '↓') : ''}
                </th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {assets.filter(a => {
                if (!typeFilter) return true;
                const type = a.type || '';
                if (typeFilter === 'image') return type.startsWith('image/');
                if (typeFilter === 'video') return type.startsWith('video/');
                return !type.startsWith('image/') && !type.startsWith('video/');
              }).sort((a, b) => {
                if (!sortConfig) return 0;
                let valA = a[sortConfig.key] || '';
                let valB = b[sortConfig.key] || '';
                if (sortConfig.key === 'size') {
                  valA = Number(valA);
                  valB = Number(valB);
                } else {
                  valA = String(valA).toLowerCase();
                  valB = String(valB).toLowerCase();
                }
                if (valA < valB) return sortConfig.direction === 'ascending' ? -1 : 1;
                if (valA > valB) return sortConfig.direction === 'ascending' ? 1 : -1;
                return 0;
              }).map(a => (
                <tr key={a.file}>
                  <td style={{ textAlign: 'center' }}>
                    {a.type && a.type.startsWith('video/') ? (
                      <video 
                        src={a.file.startsWith('http') ? a.file : a.file.startsWith('/uploads/') ? `${socketUrl}${a.file}` : `${socketUrl}/uploads/${a.file}`} 
                        style={{ width: '48px', height: '48px', objectFit: 'cover', borderRadius: '4px', cursor: 'pointer', backgroundColor: '#000' }}
                        onClick={() => onPreviewAsset(a)}
                      />
                    ) : a.type && a.type.startsWith('image/') ? (
                      <img 
                        src={a.file.startsWith('http') ? a.file : a.file.startsWith('/uploads/') ? `${socketUrl}${a.file}` : `${socketUrl}/uploads/${a.file}`} 
                        alt="thumb"
                        style={{ width: '48px', height: '48px', objectFit: 'cover', borderRadius: '4px', cursor: 'pointer', backgroundColor: 'var(--md-sys-color-surface-container-highest)' }}
                        onClick={() => onPreviewAsset(a)}
                      />
                    ) : (
                      <div 
                        style={{ width: '40px', height: '48px', margin: '0 auto', backgroundColor: 'var(--md-sys-color-primary)', borderRadius: '4px 12px 4px 4px', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', boxShadow: '0 2px 8px rgba(0,0,0,0.1)', cursor: 'pointer', flexShrink: 0 }}
                        onClick={() => onPreviewAsset(a)}
                      >
                        <div style={{ position: 'absolute', top: 0, right: 0, width: '12px', height: '12px', backgroundColor: 'var(--md-sys-color-background)', borderBottomLeftRadius: '6px' }}></div>
                        <span style={{ color: 'var(--md-sys-color-on-primary)', fontSize: '0.65rem', fontWeight: 'bold', letterSpacing: '0.5px', marginTop: '6px', userSelect: 'none' }}>
                          {a.file.split('.').pop().toUpperCase().substring(0, 4)}
                        </span>
                      </div>
                    )}
                  </td>
                  <td>
                    <span 
                      onClick={() => onPreviewAsset(a)} 
                      style={{ color: 'var(--md-sys-color-primary)', cursor: 'pointer', textDecoration: 'underline', wordBreak: 'break-all' }}
                    >
                      {a.file}
                    </span>
                  </td>
                  <td style={{ color: 'var(--md-sys-color-on-surface-variant)', fontSize: '0.85rem' }}>{a.type || 'unknown'}</td>
                  <td>{Math.round(a.size / 1024)}</td>
                  <td className="admin-actions-cell">
                    <div className="admin-actions-desktop">
                      <button onClick={() => setAssetToDelete(a)} className="icon-btn danger" title="Delete">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                      </button>
                    </div>
                    <div className="admin-actions-mobile">
                      <button className="action-menu-trigger" onClick={() => setActiveAdminMenu(activeAdminMenu?.id === a.file ? null : { type: 'assets', id: a.file })}>⋮</button>
                      {activeAdminMenu?.type === 'assets' && activeAdminMenu?.id === a.file && (
                        <div className="admin-actions-dropdown">
                          <button onClick={() => { setAssetToDelete(a); setActiveAdminMenu(null); }} className="danger">Delete</button>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}

        {activeTab === 'spaces' && (
          <div className="table-container">
            <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <label style={{ color: 'var(--md-sys-color-on-surface-variant)', fontSize: '0.9rem', fontWeight: 500 }}>Filter Creator:</label>
              <select 
                value={creatorFilter} 
                onChange={(e) => setCreatorFilter(e.target.value)}
                style={{ padding: '0.4rem 0.75rem', borderRadius: '8px', border: '1px solid var(--md-sys-color-outline-variant)', backgroundColor: 'var(--md-sys-color-surface)', color: 'var(--md-sys-color-on-surface)', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
              >
                <option value="">All Creators</option>
                {[...new Set(spaces.map(s => s.created_by))].map(creator => {
                   const creatorUser = users.find(u => u.username === creator);
                   const displayName = creatorUser ? `${creatorUser.first_name || ''} ${creatorUser.last_name || ''}`.trim() || creator : creator;
                   return <option key={creator} value={creator}>{displayName}</option>;
                })}
              </select>
            </div>
            <table className="admin-table">
            <thead>
              <tr>
                <th onClick={() => requestSort('name')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                  Name {sortConfig?.key === 'name' ? (sortConfig.direction === 'ascending' ? '↑' : '↓') : ''}
                </th>
                <th onClick={() => requestSort('created_by')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                  Created By {sortConfig?.key === 'created_by' ? (sortConfig.direction === 'ascending' ? '↑' : '↓') : ''}
                </th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {[...spaces].filter(s => !creatorFilter || s.created_by === creatorFilter).sort((a, b) => {
                if (!sortConfig) return 0;
                let valA = a[sortConfig.key] || '';
                let valB = b[sortConfig.key] || '';
                if (sortConfig.key === 'id') {
                  valA = Number(valA);
                  valB = Number(valB);
                } else {
                  valA = String(valA).toLowerCase();
                  valB = String(valB).toLowerCase();
                }
                if (valA < valB) return sortConfig.direction === 'ascending' ? -1 : 1;
                if (valA > valB) return sortConfig.direction === 'ascending' ? 1 : -1;
                return 0;
              }).map(s => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>
                    {(() => {
                      const creatorUser = users.find(u => u.username === s.created_by);
                      return creatorUser ? `${creatorUser.first_name || ''} ${creatorUser.last_name || ''}`.trim() || s.created_by : s.created_by;
                    })()}
                  </td>
                  <td className="admin-actions-cell">
                    <div className="admin-actions-desktop">
                      {s.id !== 1 && !(s.is_dm === 1 && s.name.startsWith('self_')) && (
                        <button onClick={() => setSpaceToDeleteAdmin(s)} className="icon-btn danger" title="Delete" style={{ padding: '4px' }}>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                        </button>
                      )}
                    </div>
                    {s.id !== 1 && !(s.is_dm === 1 && s.name.startsWith('self_')) && (
                      <div className="admin-actions-mobile">
                        <button className="action-menu-trigger" onClick={() => setActiveAdminMenu(activeAdminMenu?.id === s.id ? null : { type: 'spaces', id: s.id })}>⋮</button>
                        {activeAdminMenu?.type === 'spaces' && activeAdminMenu?.id === s.id && (
                          <div className="admin-actions-dropdown">
                            <button onClick={() => { setSpaceToDeleteAdmin(s); setActiveAdminMenu(null); }} className="danger">Delete</button>
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}

        {/* Confirm Delete Modals */}
        {userToDelete && (
          <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 10000 }}>
            <div className="auth-card" style={{ maxWidth: '400px', textAlign: 'center' }}>
              <h2 style={{ color: 'var(--md-sys-color-error)' }}>Delete User?</h2>
              <p>Are you sure you want to delete <strong>{userToDelete.first_name ? `${userToDelete.first_name} ${userToDelete.last_name || ''}`.trim() : userToDelete.username}</strong>? This action cannot be undone.</p>
              <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
                <button type="button" className="btn-secondary" onClick={() => setUserToDelete(null)} style={{ flex: 1 }}>Cancel</button>
                <button type="button" className="btn-primary" onClick={() => deleteUser(userToDelete.id)} style={{ flex: 1, backgroundColor: 'var(--md-sys-color-error)', color: '#fff' }}>Delete</button>
              </div>
            </div>
          </div>
        )}

        {assetToDelete && (
          <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 10000 }}>
            <div className="auth-card" style={{ maxWidth: '400px', textAlign: 'center' }}>
              <h2 style={{ color: 'var(--md-sys-color-error)' }}>Delete Asset?</h2>
              <p>Are you sure you want to delete <strong>{assetToDelete.file}</strong>?</p>
              <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
                <button type="button" className="btn-secondary" onClick={() => setAssetToDelete(null)} style={{ flex: 1 }}>Cancel</button>
                <button type="button" className="btn-primary" onClick={() => deleteAsset(assetToDelete.file)} style={{ flex: 1, backgroundColor: 'var(--md-sys-color-error)', color: '#fff' }}>Delete</button>
              </div>
            </div>
          </div>
        )}

        {spaceToDeleteAdmin && (
          <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 10000 }}>
            <div className="auth-card" style={{ maxWidth: '400px', textAlign: 'center' }}>
              <h2 style={{ color: 'var(--md-sys-color-error)' }}>Delete Space?</h2>
              <p>Are you sure you want to delete <strong>#{spaceToDeleteAdmin.name}</strong>? All messages will be lost.</p>
              <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
                <button type="button" className="btn-secondary" onClick={() => setSpaceToDeleteAdmin(null)} style={{ flex: 1 }}>Cancel</button>
                <button type="button" className="btn-primary" onClick={() => deleteSpace(spaceToDeleteAdmin.id)} style={{ flex: 1, backgroundColor: 'var(--md-sys-color-error)', color: '#fff' }}>Delete</button>
              </div>
            </div>
          </div>
        )}


      </div>
      {adminCroppingImage && (
        <AvatarCropper 
          image={adminCroppingImage} 
          onComplete={(croppedBase64) => {
            setEditingUser({...editingUser, avatar: croppedBase64});
            setAdminCroppingImage(null);
          }} 
          onCancel={() => setAdminCroppingImage(null)} 
        />
      )}
    </div>
  );
};

function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [socket, setSocket] = useState(null);
  const chatEndRef = useRef(null);
  const debounceRef = useRef(null);
  const [selectedAsset, setSelectedAsset] = useState(null);
  const [isUploadingMedia, setIsUploadingMedia] = useState(false);
  const [readReceipts, setReadReceipts] = useState({});
  const topAnchorRef = useRef(null);
  const [isFetchingHistory, setIsFetchingHistory] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);

  // Phase 9: Media Integrations
  const [showMediaMenu, setShowMediaMenu] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [gifSearch, setGifSearch] = useState('');
  
  // Phase 12: Pinned Messages Board
  const [showPinnedBoard, setShowPinnedBoard] = useState(false);
  const [pinnedMessages, setPinnedMessages] = useState([]);
  const [gifs, setGifs] = useState([]);
  const [reactingToMsgId, setReactingToMsgId] = useState(null);

  // Auth State
  const [token, setToken] = useState(localStorage.getItem('token') || null);
  const [username, setUsername] = useState(localStorage.getItem('username') || '');
  const [authMode, setAuthMode] = useState('login'); // 'login', 'register', 'forgot', 'reset'
  const [authUsername, setAuthUsername] = useState('');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authSuccess, setAuthSuccess] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [role, setRole] = useState(localStorage.getItem('role') || 'user');

  // E2EE PKI Identity State
  const privateKeyRef = useRef(null);
  useEffect(() => {
    const rawJwkStr = localStorage.getItem('prado_decryption_key');
    if (rawJwkStr) {
      syncPrivateKeyToIDB(rawJwkStr);
      importPrivateKey(rawJwkStr)
        .then(key => { privateKeyRef.current = key; })
        .catch(err => console.error("Failed to import cached private key", err));
    }
  }, []);

  // Theming & Profile State
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'light');
  const [colorPalette, setColorPalette] = useState(() => {
    const saved = localStorage.getItem('colorPalette');
    if (saved === '#d0bcff') return '#4CAF50';
    if (saved && saved.startsWith('#')) return saved;
    return '#4CAF50';
  });
  const [avatar, setAvatar] = useState(localStorage.getItem('avatar') || null);

  const [showSettings, setShowSettings] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [showVideoRoom, setShowVideoRoom] = useState(false);
  const [globalFont, setGlobalFont] = useState('Roboto');
  const [uiScale, setUiScale] = useState(() => parseFloat(localStorage.getItem('uiScale')) || 1.0);

  useEffect(() => {
    document.documentElement.style.fontSize = `${16 * uiScale}px`;
    localStorage.setItem('uiScale', uiScale);
  }, [uiScale]);
  const dropdownRef = useRef(null);
  const mediaMenuRef = useRef(null);
  const startChatRef = useRef(null);
  const spaceMenuRef = useRef(null);
  const [pwChange, setPwChange] = useState({ current: '', next: '', confirm: '', msg: null });

  // Expanded Profile State
  const [profileData, setProfileData] = useState({
    first_name: '',
    last_name: '',
    email: '',
    location: '',
    font_family: 'Roboto'
  });
  const profileDataRef = useRef(null);
  useEffect(() => { profileDataRef.current = profileData; }, [profileData]);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const weather = useWeather(profileData.location);
  const [tempAvatar, setTempAvatar] = useState(null);
  const [croppingImage, setCroppingImage] = useState(null);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [promptNotification, setPromptNotification] = useState(false);
  const [isSubscribing, setIsSubscribing] = useState(false);

  // Location Autocomplete State

  // Fetch Global Settings
  useEffect(() => {
    fetch(`${socketUrl}/api/settings`)
      .then(res => res.json())
      .then(data => {
        if (data.global_font) setGlobalFont(data.global_font);
      })
      .catch(console.error);
  }, []);

  // Sync Google Font Injection
  useEffect(() => {
    const activeFont = profileData.font_family || globalFont;
    if (!activeFont) return;
    const fontName = activeFont.replace(/ /g, '+');
    const linkId = 'google-font-link';
    let link = document.getElementById(linkId);
    if (!link) {
      link = document.createElement('link');
      link.id = linkId;
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    link.href = `https://fonts.googleapis.com/css2?family=${fontName}:wght@300;400;500;600;700&display=swap`;
    document.body.style.setProperty('--primary-font', `'${activeFont}', sans-serif`);
  }, [globalFont, profileData.font_family]);

  // Chat Spaces State
  const [spaces, setSpaces] = useState([]);
  const [currentSpace, setCurrentSpace] = useState(() => {
    const saved = localStorage.getItem('lastSpaceId');
    return { id: saved ? Number(saved) : null, name: 'Loading...' };
  });
  const [unreadCounts, setUnreadCounts] = useState({});
  const currentSpaceRef = useRef(1);
  const provisioningLocksRef = useRef(new Set());

  useEffect(() => {
    currentSpaceRef.current = currentSpace?.id;
    if (currentSpace?.id) {
      localStorage.setItem('lastSpaceId', currentSpace.id);
      setUnreadCounts(prev => ({ ...prev, [currentSpace.id]: 0 }));
    }
  }, [currentSpace?.id]);

  const [mobileView, setMobileView] = useState('list'); // 'list' or 'chat'
  const [showSidebar, setShowSidebar] = useState(false);
  const [newSpaceName, setNewSpaceName] = useState('');
  const [isNewSpacePrivate, setIsNewSpacePrivate] = useState(false);
  const [showSpaceModal, setShowSpaceModal] = useState(false);
  const [newSpaceE2EE, setNewSpaceE2EE] = useState(false);
  const [activeKeys, setActiveKeys] = useState({});
  const activeKeysRef = useRef({});
  useEffect(() => { activeKeysRef.current = activeKeys; }, [activeKeys]);
  const spacesRef = useRef([]);
  useEffect(() => { spacesRef.current = spaces; }, [spaces]);
  const [showE2EEPrompt, setShowE2EEPrompt] = useState(null);
  const [e2eeDecryptError, setE2eeDecryptError] = useState(false);
  const [showDMModal, setShowDMModal] = useState(false);
  const [showStartChatMenu, setShowStartChatMenu] = useState(false);
  const [activeSpaceMenu, setActiveSpaceMenu] = useState(null);
  const [isCreatingDM, setIsCreatingDM] = useState(false);
  const [showRoomSettingsModal, setShowRoomSettingsModal] = useState(false);
  const [invitedUsers, setInvitedUsers] = useState([]);
  const [alreadyInvited, setAlreadyInvited] = useState([]);
  const [roomSettingsInvitedUsers, setRoomSettingsInvitedUsers] = useState([]);
  const [isUpdatingRoom, setIsUpdatingRoom] = useState(false);
  const [allUsers, setAllUsers] = useState([]);
  const [spaceToDelete, setSpaceToDelete] = useState(null);
  const [spaceToLeave, setSpaceToLeave] = useState(null);
  const [isCreatingSpace, setIsCreatingSpace] = useState(false);
  const [pendingAsset, setPendingAsset] = useState(null);
  const [appReady, setAppReady] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editInput, setEditInput] = useState('');
  const editInputRef = useRef(null);
  const [msgToDelete, setMsgToDelete] = useState(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [showTimestampId, setShowTimestampId] = useState(null);
  const [formatToolbar, setFormatToolbar] = useState(null); // { top, left }
  const richInputRef = useRef(null);

  const applyFormat = (command) => {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const anchor = sel.anchorNode;
    const el = anchor?.nodeType === Node.TEXT_NODE ? anchor.parentElement?.closest('[contenteditable]') : anchor?.closest?.('[contenteditable]');
    if (!el) return;
    el.focus();
    if (command === 'code') {
      if (!sel.isCollapsed) {
        const selectedText = sel.toString();
        document.execCommand('insertHTML', false, `<code>${selectedText}</code>\u200B`);
      }
    } else {
      document.execCommand(command, false, null);
    }
    setFormatToolbar(null);
    // Sync the correct state
    if (el === richInputRef.current) setInput(serializeToMarkdown(el));
    else if (el === editInputRef.current) setEditInput(serializeToMarkdown(el));
  };

  const handleTextSelect = () => {
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed || !sel.toString().trim()) {
      setFormatToolbar(null);
      return;
    }
    // Position the toolbar above the selection
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    setFormatToolbar({ top: rect.top - 44, left: rect.left + (rect.width / 2) });
  };

  const handleSpaceSelect = async (space) => {
    if (space.id === currentSpace?.id) return;
    setMessages([]);
    setHistoryLoaded(false);
    if (isEncryptedSpace(space) && !activeKeys[space.id] && privateKeyRef.current) {
      try {
        const keysRes = await fetch(`${socketUrl}/api/spaces/keys`, { headers: { 'Authorization': `Bearer ${token}` }, cache: 'no-store' });
        if (keysRes.ok) {
          const keysData = await keysRes.json();
          const targetKeyObj = keysData.find(kd => kd.space_id === space.id);
          if (targetKeyObj) {
            const roomKey = await decryptRoomKeyWithPrivateKey(targetKeyObj.encrypted_room_key, privateKeyRef.current);
            setActiveKeys(prev => ({ ...prev, [space.id]: roomKey }));
            await syncRoomKeyToIDB(space.id, roomKey);
          } else if (socket) {
            // No key found — request it from online members who already have access
            socket.emit('request_room_key', { spaceId: space.id, requesterId: profileData.id, requesterPublicKey: profileData.public_key });
          }
        }
      } catch (e) {
        console.error("Silent key fetch failed for handleSpaceSelect", e);
      }
    }
    
    setCurrentSpace(space);
    setShowSidebar(false);
    setMobileView('chat');
  };


  // Location Autocomplete State
  const [locationSuggestions, setLocationSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const locationTimeoutRef = useRef(null);

  // Presence & Active Typing State
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [typingUsers, setTypingUsers] = useState([]);
  const typingTimeoutRef = useRef(null);

  const subscribeToPush = async () => {
    if (!('serviceWorker' in navigator)) return;
    setIsSubscribing(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      
      // Get VAPID public key
      const keyRes = await fetch(`${socketUrl}/api/push/vapid-public-key`);
      const { publicKey } = await keyRes.json();
      
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
      
      // Send to backend
      const res = await fetch(`${socketUrl}/api/push/subscribe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(subscription.toJSON ? subscription.toJSON() : subscription)
      });
      
      if (res.ok) {
        setPushEnabled(true);
        console.log('Push subscription successful');
      }
    } catch (err) {
      console.error('Push Subscription Failed', err);
      setPushEnabled(false);
    } finally {
      setIsSubscribing(false);
    }
  };

  const togglePushNotifications = async () => {
    if (pushEnabled) {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await subscription.unsubscribe();
        setPushEnabled(false);
      }
    } else {
      await subscribeToPush();
    }
  };

  useEffect(() => {
    if ('serviceWorker' in navigator && token) {
      navigator.serviceWorker.register('/sw.js')
        .then(reg => {
          reg.pushManager.getSubscription().then(sub => {
            setPushEnabled(!!sub);
            if (sub) {
              fetch(`${socketUrl}/api/push/subscribe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify(sub)
              }).catch(e => console.error("Silent Re-sync failed", e));
            } else if ('Notification' in window && Notification.permission === 'default') {
              setPromptNotification(true);
            }
          });
        })
        .catch(err => console.error('SW Registration Failed', err));
    }
  }, [token, socketUrl]);

  // Listen for Service Worker messages (click-to-open, inline reply)
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const handler = (event) => {
      const { type, spaceId, text, focusInput } = event.data || {};
      
      if (type === 'NAVIGATE_TO_SPACE' && spaceId) {
        const target = spaces.find(s => Number(s.id) === Number(spaceId));
        if (target) {
          setCurrentSpace(target);
          setMobileView('chat');
          setShowSidebar(false);
          // Auto-focus the message input when Reply is clicked
          if (focusInput) {
            setTimeout(() => {
              const input = document.querySelector('.rich-input');
              if (input) input.focus();
            }, 300);
          }
        }
      }
      
      if (type === 'PUSH_REPLY' && spaceId && text && socket) {
        socket.emit('chat message', { text, spaceId: Number(spaceId) });
      }
    };
    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  }, [spaces, socket]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setShowDropdown(false);
      }
      if (mediaMenuRef.current && !mediaMenuRef.current.contains(event.target)) {
        setShowMediaMenu(false);
        setShowEmojiPicker(false);
        setShowGifPicker(false);
      }
      if (startChatRef.current && !startChatRef.current.contains(event.target)) {
        setShowStartChatMenu(false);
      }
      if (spaceMenuRef.current && !spaceMenuRef.current.contains(event.target)) {
        setActiveSpaceMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Derive dynamic material theme styles
  const rgb = hexToRgb(colorPalette);
  const isDark = theme === 'dark';

  const dynamicStyles = {
    '--md-sys-color-primary': colorPalette,
    '--md-sys-color-on-primary': getContrastColor(colorPalette),
    '--md-sys-color-primary-container': isDark ? `rgba(${rgb}, 0.3)` : `rgba(${rgb}, 0.15)`,
    '--md-sys-color-on-primary-container': isDark ? '#ffffff' : '#000000',
    '--md-sys-color-secondary': `rgba(${rgb}, 0.6)`,
    '--md-sys-color-on-secondary': '#ffffff',
    '--md-sys-color-secondary-container': isDark ? `rgba(${rgb}, 0.15)` : `rgba(${rgb}, 0.08)`,
    '--md-sys-color-on-secondary-container': isDark ? '#ffffff' : '#000000',
  };

  const isInitialLoad = useRef(true);

  const scrollToBottom = (instant = false) => {
    setTimeout(() => {
      if (chatEndRef.current && chatEndRef.current.parentElement) {
        const container = chatEndRef.current.parentElement;
        container.scrollTo({
          top: container.scrollHeight,
          behavior: instant ? 'auto' : 'smooth'
        });
      }
    }, 50);
  };

  useEffect(() => {
    if (messages.length > 0 || typingUsers.length > 0) {
      scrollToBottom(isInitialLoad.current);
      if (isInitialLoad.current) {
        setTimeout(() => { isInitialLoad.current = false; }, 500);
      }
    }
  }, [messages, typingUsers]);

  // App Readiness Logic
  useEffect(() => {
    if (!token) {
      setAppReady(true);
      return;
    }
    // If logged in, wait for connection, spaces AND history
    if (isConnected && spaces.length > 0 && historyLoaded) {
      const timer = setTimeout(() => setAppReady(true), 1000); 
      return () => clearTimeout(timer);
    }
    
    // Failsafe for orphaned DB wipes
    const failsafe = setTimeout(() => setAppReady(true), 3500);
    return () => clearTimeout(failsafe);
  }, [token, isConnected, spaces, historyLoaded]);

  // Detect currentSpace removal cleanly
  useEffect(() => {
    if (spaces.length > 0 && !spaces.find(s => s.id === currentSpace.id)) {
      const selfDm = spaces.find(s => s.is_dm === 1 && s.name.startsWith('self_'));
      setCurrentSpace(selfDm || spaces[0]);
    }
  }, [spaces, currentSpace.id]);

  // Fetch Spaces when token exists
  useEffect(() => {
    if (!token) return;
    const fetchSpaces = async () => {
      try {
        const [spacesRes, keysRes] = await Promise.all([
          fetch(`${socketUrl}/api/spaces`, { headers: { 'Authorization': `Bearer ${token}` }, cache: 'no-store' }),
          fetch(`${socketUrl}/api/spaces/keys`, { headers: { 'Authorization': `Bearer ${token}` }, cache: 'no-store' })
        ]);

        if (spacesRes.status === 401 || spacesRes.status === 403) {
          handleLogout();
          return;
        }

        if (spacesRes.ok) {
          const spacesData = await spacesRes.json();

          let newActiveKeys = {};
          if (keysRes.ok) {
             const keysData = await keysRes.json();
             let pKey = privateKeyRef.current;
             if (!pKey) {
                const jwkString = localStorage.getItem('prado_decryption_key');
                if (jwkString) {
                   syncPrivateKeyToIDB(jwkString);
                   pKey = await importPrivateKey(jwkString);
                   privateKeyRef.current = pKey;
                }
             }

             if (pKey && keysData.length > 0) {
               await Promise.all(keysData.map(async (kd) => {
                 try {
                   const roomKey = await decryptRoomKeyWithPrivateKey(kd.encrypted_room_key, pKey);
                   newActiveKeys[kd.space_id] = roomKey;
                   await syncRoomKeyToIDB(kd.space_id, roomKey);
                 } catch (e) {
                   console.error(`Failed to silently decrypt room key for space ${kd.space_id}`, e);
                 }
               }));
               setActiveKeys(prev => ({ ...prev, ...newActiveKeys }));
             }
          }

          // Force React DOM to delay mapping spaces until activeKeys have completely synced Cyphers synchronously
          setSpaces(spacesData);

          // Legacy hardcoded detached Auto-Provision Removed Here

          if (spacesData.length > 0) {
            const lastSpaceId = localStorage.getItem('lastSpaceId');
            const lastSpace = lastSpaceId ? spacesData.find(s => Number(s.id) === Number(lastSpaceId)) : null;
            const selfDm = spacesData.find(s => s.is_dm === 1 && s.name.startsWith('self_'));
            setCurrentSpace(lastSpace || selfDm || spacesData[0]);
          }
        }
      } catch (err) { console.error('Failed to load spaces or keys', err) }
    };
    fetchSpaces();
  }, [token]);

  // Auto-Provision Keys for Notes to Self robustly deferred until component mounts completely
  useEffect(() => {
    if (!profileData?.id || !profileData?.public_key || spaces.length === 0 || !isConnected) return;
    const selfDm = spaces.find(s => s.is_dm === 1 && s.name.startsWith('self_'));
    if (!selfDm || activeKeys[selfDm.id] || provisioningLocksRef.current.has(selfDm.id)) return;
    
    provisioningLocksRef.current.add(selfDm.id);
    const provisionKey = async () => {
      try {
        let localPrivKey = privateKeyRef.current;
        if (!localPrivKey) {
           const jwkString = localStorage.getItem('prado_decryption_key');
           if (jwkString) {
              localPrivKey = await importPrivateKey(jwkString);
              privateKeyRef.current = localPrivKey;
           } else {
              return;
           }
        }
        const roomKey = await generateRoomKey();
        const peerEnc = await encryptRoomKeyWithPublicKey(roomKey, profileData.public_key);
        const res = await fetch(`${socketUrl}/api/spaces/${selfDm.id}/invite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ invited_users: [profileData.id], keyShares: { [profileData.id]: peerEnc } })
        });
        if (res.ok) {
          setActiveKeys(prev => ({ ...prev, [selfDm.id]: roomKey }));
          await syncRoomKeyToIDB(selfDm.id, roomKey);
        } else {
          provisioningLocksRef.current.delete(selfDm.id);
        }
      } catch (e) {
        console.error("Failed auto-provisioning Notes to Self", e);
        provisioningLocksRef.current.delete(selfDm.id);
      }
    };
    provisionKey();
  }, [spaces, activeKeys, profileData, token, socketUrl, isConnected]);

  // Retroactive Sweeper for Late-Arriving Keys (with re-entry guard)
  const isDecryptingRef = useRef(false);
  useEffect(() => {
    if (isDecryptingRef.current) return;
    if (!activeKeys[currentSpace?.id] || messages.length === 0) return;
    const key = activeKeys[currentSpace.id];
    const hasEncrypted = messages.some(m => m.raw_text && m.text === '🔒 [Encrypted Message]');
    if (!hasEncrypted) return;
    
    isDecryptingRef.current = true;
    Promise.all(messages.map(async (msg) => {
      if (msg.raw_text && msg.text === '🔒 [Encrypted Message]') {
        try {
          const dec = await decryptMessage(msg.raw_text, key);
          return { ...msg, text: dec, raw_text: null };
        } catch(e) {
          return { ...msg, text: '🔒 [Decryption Failed]', raw_text: null };
        }
      }
      return msg;
    })).then(newMsgs => {
      setMessages(newMsgs);
      isDecryptingRef.current = false;
    });
  }, [messages, activeKeys, currentSpace?.id]);

  // Connect socket when token changes
  useEffect(() => {
    if (!token) return;

    const newSocket = io(socketUrl, {
      auth: { token },
      autoConnect: true
    });
    setSocket(newSocket);

    newSocket.on('connect', () => setIsConnected(true));
    newSocket.on('disconnect', () => setIsConnected(false));
    newSocket.on('connect_error', (err) => {
      if (err.message && err.message.startsWith('Authentication error')) {
        handleLogout();
      }
    });

    newSocket.on('presence', (users) => {
      setOnlineUsers(users);
    });

    newSocket.on('user typing', ({ username: typer, spaceId, avatar, first_name }) => {
      setTypingUsers(prev => {
        if (prev.find(u => u.username === typer && Number(u.spaceId) === Number(spaceId))) return prev;
        return [...prev.filter(u => u.username !== typer), { username: typer, spaceId, avatar, first_name }];
      });
    });

    newSocket.on('user stopped typing', ({ username: typer, spaceId }) => {
      setTypingUsers(prev => prev.filter(u => !(u.username === typer && Number(u.spaceId) === Number(spaceId))));
    });

    newSocket.on('space history', async (history) => {
      const spaceId = Number(currentSpaceRef.current);
      let processedHistory = history;

      processedHistory = await Promise.all(history.map(async (msg) => {
         if (!msg.text || typeof msg.text !== 'string') return msg;
         const d = await tryDecryptMsg(msg.text, activeKeysRef.current[spaceId]);
         return { ...msg, ...d };
      }));
      setMessages(processedHistory);
      setHistoryLoaded(true);
    });

    newSocket.on('chat message', async (msg) => {
      const spaceId = Number(msg.spaceId);
      let processedMsg = msg;

      if (msg.text && typeof msg.text === 'string') {
         const d = await tryDecryptMsg(msg.text, activeKeysRef.current[spaceId]);
         processedMsg = { ...msg, ...d };
      }

      if (Number(currentSpaceRef.current) === spaceId) {
        setMessages(prev => [...prev, processedMsg]);
      } else {
        setUnreadCounts(prev => ({ ...prev, [spaceId]: (prev[spaceId] || 0) + 1 }));
      }
    });

    newSocket.on('message stored', ({ tempId, id }) => {
      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, id } : m));
    });

    newSocket.on('message updated', async ({ id, text, edited, spaceId }) => {
      if (text && typeof text === 'string') {
        const d = await tryDecryptMsg(text, activeKeysRef.current[spaceId]);
        if (d.raw_text) {
          // Key not available — preserve raw_text for retroactive sweeper
          setMessages(prev => prev.map(m => m.id === id ? { ...m, text: d.text, raw_text: d.raw_text, edited } : m));
          return;
        }
        setMessages(prev => prev.map(m => m.id === id ? { ...m, text: d.text, edited } : m));
      } else {
        setMessages(prev => prev.map(m => m.id === id ? { ...m, text, edited } : m));
      }
    });

    newSocket.on('message deleted', ({ id }) => {
      setMessages(prev => prev.filter(m => m.id !== id));
    });

    newSocket.on('message pinned', ({ id, is_pinned }) => {
      setMessages(prev => prev.map(m => m.id === id ? { ...m, is_pinned } : m));
      // Re-hydrate the absolute Pinned Drawer ensuring fresh display data seamlessly overrides
      fetchPinnedMessages();
    });

    newSocket.on('message reacted', ({ id, reactions }) => {
      setMessages(prev => prev.map(m => m.id === id ? { ...m, reactions } : m));
    });
    newSocket.on('user profile updated', ({ username: uName, avatar, font_family, location }) => {
      setMessages(prev => prev.map(m => m.sender === uName ? { ...m, avatar, font_family } : m));
      setSpaces(prev => prev.map(s => (s.is_dm === 1 && s.dm_username === uName) ? { ...s, dm_avatar: avatar } : s));
      setCurrentSpace(prev => (prev && prev.is_dm === 1 && prev.dm_username === uName) ? { ...prev, dm_avatar: avatar } : prev);
      setAllUsers(prev => prev.map(u => u.username === uName ? { ...u, avatar, font_family, location } : u));
    });

    newSocket.on('settings-updated', (settings) => {
      if (settings.global_font) {
        setGlobalFont(settings.global_font);
      }
    });

    // Auto-grant room keys to members who request them
    newSocket.on('request_room_key', async (data) => {
      const { spaceId, requesterId, requesterPublicKey, requesterSocketId } = data;
      const myKey = activeKeysRef.current[spaceId];
      if (!myKey || !requesterPublicKey) return;
      try {
        const encryptedForRequester = await encryptRoomKeyWithPublicKey(myKey, requesterPublicKey);
        newSocket.emit('grant_room_key', {
          spaceId,
          requesterId,
          encryptedRoomKey: encryptedForRequester,
          requesterSocketId
        });
      } catch (e) {
        console.error('Failed to grant room key', e);
      }
    });

    // Receive a granted room key
    newSocket.on('grant_room_key', async (data) => {
      const { spaceId, encryptedRoomKey } = data;
      if (!encryptedRoomKey || !privateKeyRef.current || activeKeysRef.current[spaceId]) return;
      try {
        const roomKey = await decryptRoomKeyWithPrivateKey(encryptedRoomKey, privateKeyRef.current);
        setActiveKeys(prev => ({ ...prev, [spaceId]: roomKey }));
        await syncRoomKeyToIDB(spaceId, roomKey);
      } catch (e) {
        console.error('Failed to import granted room key', e);
      }
    });

    const reloadSpacesSilently = async () => {
      try {
        const res = await fetch(`${socketUrl}/api/spaces`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (res.ok) setSpaces(await res.json());
      } catch(e) { console.error('Failed to sync spaces:', e); }
    };

    newSocket.on('space created', (newSpace) => {
      console.log('Socket received space created:', newSpace);
      if (newSpace.is_dm === 1) reloadSpacesSilently();
      else setSpaces(prev => {
        if (!prev.find(s => s.id === newSpace.id)) return [...prev, newSpace];
        return prev;
      });
    });

    newSocket.on('space invited', (spaceObj) => {
      console.log('Socket received space invited:', spaceObj);
      if (spaceObj.is_dm === 1) reloadSpacesSilently();
      else setSpaces(prev => {
        if (!prev.find(s => s.id === spaceObj.id)) return [...prev, spaceObj];
        return prev;
      });
    });

    newSocket.on('space deleted', (deletedId) => {
      const id = parseInt(deletedId, 10);
      setSpaces(prev => prev.filter(s => s.id !== id));
      setCurrentSpace(curr => curr.id === id ? (spaces.find(s => s.is_dm === 1 && s.name.startsWith('self_')) || spaces[0] || { id: null, name: 'Loading...' }) : curr);
    });

    newSocket.on('space left', () => {
      fetch(`${socketUrl}/api/spaces`, { headers: { 'Authorization': `Bearer ${token}` }, cache: 'no-store' })
        .then(res => res.json())
        .then(data => setSpaces(data))
        .catch(err => console.error('Failed to sync spaces after leave sync', err));
    });

    newSocket.on('read_receipts_init', (map) => {
      setReadReceipts(map || {});
    });

    newSocket.on('read_receipt_update', ({ username: rUser, message_id: rMsgId }) => {
      setReadReceipts(prev => ({ ...prev, [rUser]: rMsgId }));
    });

    return () => {
      newSocket.off('connect');
      newSocket.off('disconnect');
      newSocket.off('connect_error');
      newSocket.off('presence');
      newSocket.off('user typing');
      newSocket.off('user stopped typing');
      newSocket.off('space history');
      newSocket.off('chat message');
      newSocket.off('settings-updated');
      newSocket.off('space created');
      newSocket.off('space invited');
      newSocket.off('space deleted');
      newSocket.off('read_receipts_init');
      newSocket.off('read_receipt_update');
      newSocket.disconnect();
    };
  }, [token]);

  // Handle Mark Read
  useEffect(() => {
    if (messages.length > 0 && socket && isConnected) {
      const lastMsg = messages[messages.length - 1];
      socket.emit('mark_read', { space_id: lastMsg.spaceId, message_id: lastMsg.id });
    }
  }, [messages, socket, isConnected, currentSpace.id]);

  // Phase 12: Pinned Messages Fetching
  const fetchPinnedMessages = useCallback(async () => {
    if (!currentSpace) return;
    try {
      const res = await fetch(`${socketUrl}/api/spaces/${currentSpace.id}/pinned`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      
      let processedData = data;

      processedData = await Promise.all(data.map(async (msg) => {
         if (!msg.text || typeof msg.text !== 'string') return msg;
         const d = await tryDecryptMsg(msg.text, activeKeysRef.current[currentSpace.id]);
         return { ...msg, ...d };
      }));
      setPinnedMessages(processedData);
    } catch(err) {
      console.error('Failed fetching pinned messages:', err);
    }
  }, [currentSpace, token]);

  useEffect(() => {
    if (showPinnedBoard) fetchPinnedMessages();
  }, [showPinnedBoard, fetchPinnedMessages]);

  // Handle Socket Room Joining
  useEffect(() => {
    setHasMoreHistory(true);
    setShowPinnedBoard(false); // Close pin board when switching rooms
  }, [currentSpace]);

  // Infinite Scroll Intersection
  useEffect(() => {
    if (!topAnchorRef.current || !hasMoreHistory || isFetchingHistory || messages.length === 0) return;

    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        setIsFetchingHistory(true);
        const oldestId = messages[0].id;
        const container = topAnchorRef.current.parentElement;
        const previousScrollHeight = container.scrollHeight;

        fetch(`${socketUrl}/api/spaces/${currentSpace.id}/messages?before_id=${oldestId}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        })
        .then(res => res.json())
        .then(async olderMessages => {
          if (olderMessages.length < 50) setHasMoreHistory(false);
          if (olderMessages.length > 0) {
            const processedOlder = await Promise.all(olderMessages.map(async (msg) => {
              if (!msg.text || typeof msg.text !== 'string') return msg;
              const d = await tryDecryptMsg(msg.text, activeKeys[currentSpace.id]);
              return { ...msg, ...d };
            }));
            setMessages(prev => [...processedOlder, ...prev]);
            requestAnimationFrame(() => {
              if (container) container.scrollTop = container.scrollHeight - previousScrollHeight;
            });
          }
        })
        .catch(err => console.error('History fetch failed:', err))
        .finally(() => setIsFetchingHistory(false));
      }
    }, { root: null, rootMargin: '100px' });

    observer.observe(topAnchorRef.current);
    return () => observer.disconnect();
  }, [messages, hasMoreHistory, isFetchingHistory, currentSpace.id, token]);

  useEffect(() => {
    if (socket && isConnected) {
      isInitialLoad.current = true;
      socket.emit('join space', currentSpace.id);
      setHistoryLoaded(false); // Reset when switching spaces or re-connecting
    }
  }, [socket, isConnected, currentSpace.id]);

  // Install Prompt logic
  useEffect(() => {
    const handleBeforeInstallPrompt = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
  }, []);

  const handleInstallClick = () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(() => {
        setDeferredPrompt(null);
      });
    }
  };

  const inviteToRoom = async (e) => {
    e.preventDefault();
    if (isUpdatingRoom || roomSettingsInvitedUsers.length === 0) return;
    setIsUpdatingRoom(true);

    let keyShares = {};
    if (privateKeyRef.current && activeKeysRef.current[currentSpace.id]) {
      try {
        const roomKeyObj = activeKeysRef.current[currentSpace.id];
        for (const uId of roomSettingsInvitedUsers) {
           const userObj = allUsers.find(u => u.id === Number(uId));
           if (userObj && userObj.public_key) {
             const peerEnc = await encryptRoomKeyWithPublicKey(roomKeyObj, userObj.public_key);
             keyShares[uId] = peerEnc;
           }
        }
      } catch (keyErr) {
        console.error("Failed to generate Room Key matrix for invites", keyErr);
        alert('E2EE Setup Failed for invitations. Ensure all users have valid profiles.');
        setIsUpdatingRoom(false);
        return;
      }
    }

    try {
      const res = await fetch(`${socketUrl}/api/spaces/${currentSpace.id}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ invited_users: roomSettingsInvitedUsers, keyShares })
      });
      if (res.ok) {
        setShowRoomSettingsModal(false);
        setRoomSettingsInvitedUsers([]);
        alert('Users invited successfully!');
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to invite users');
      }
    } catch (err) {
      console.error(err);
      alert('Error inviting users');
    } finally {
      setIsUpdatingRoom(false);
    }
  };

  const handleAuth = async (e) => {
    e.preventDefault();
    setAuthError('');
    setAuthSuccess('');
    try {
      const payload = { email: authEmail, password: authPassword };
      
      let fetchMode = authMode;
      if (authMode === 'register') {
        try {
          const keyPair = await generateIdentityKeyPair();
          payload.publicKey = await exportPublicKey(keyPair);
          payload.wrappedPrivateKey = await wrapPrivateKey(keyPair.privateKey, authPassword, authEmail);
        } catch (keysErr) {
          setAuthError('Failed to generate secure encryption keys locally.');
          return;
        }
      } else if (authMode === 'forgot') {
        fetchMode = 'forgot-password';
        delete payload.password;
        payload.email = authEmail;
      } else if (authMode === 'reset') {
        fetchMode = 'reset-password';
        delete payload.email;
        payload.token = resetToken;
        payload.newPassword = authPassword;
      }

      const res = await fetch(`${socketUrl}/api/${fetchMode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok) {
        setAuthError(data.error || 'Authentication failed');
        return;
      }

      if (authMode === 'register' || authMode === 'forgot' || authMode === 'reset') {
        setAuthMode('login');
        setAuthSuccess(data.message || 'Operation successful. Please log in.');
        setAuthPassword('');
        setAuthUsername('');
        setAuthEmail('');
      } else {
        localStorage.setItem('token', data.token);
        localStorage.setItem('username', data.username);

        if (data.wrapped_private_key) {
          try {
            const privateKey = await unwrapPrivateKey(data.wrapped_private_key, authPassword, authEmail);
            const exportedPrivateJwk = await window.crypto.subtle.exportKey("jwk", privateKey);
            const jwkStr = JSON.stringify(exportedPrivateJwk);
            localStorage.setItem('prado_decryption_key', jwkStr);
            syncPrivateKeyToIDB(jwkStr);
            privateKeyRef.current = privateKey;
          } catch (unwrapErr) {
            console.error('Failed to unwrap private key', unwrapErr);
          }
        }

        const backendTheme = data.theme || 'dark';
        let backendPalette = data.color_palette || '#4CAF50';
        if (backendPalette === '#d0bcff' || !backendPalette.startsWith('#')) backendPalette = '#4CAF50';
        const backendAvatar = data.avatar || null;

        localStorage.setItem('theme', backendTheme);
        localStorage.setItem('colorPalette', backendPalette);
        if (backendAvatar) {
          localStorage.setItem('avatar', backendAvatar);
        } else {
          localStorage.removeItem('avatar');
        }

        setTheme(backendTheme);
        setColorPalette(backendPalette);
        setAvatar(backendAvatar);
        setRole(data.role || 'user');
        localStorage.setItem('role', data.role || 'user');

        if (data.font_family) {
          setProfileData(prev => ({ ...prev, font_family: data.font_family }));
        }

        setToken(data.token);
        setUsername(data.username);
        setAuthUsername('');
        setAuthPassword('');
        fetchProfile(data.token);

        if ('Notification' in window && Notification.permission === 'default') {
          setPromptNotification(true);
        }
      }
    } catch (err) {
      setAuthError('Network error');
    }
  };

  const fetchProfile = async (currentToken) => {
    const t = currentToken || token;
    if (!t) return;
    try {
      const res = await fetch(`${socketUrl}/api/profile`, {
        headers: { 'Authorization': `Bearer ${t}`, 'Cache-Control': 'no-cache' }
      });
      if (res.ok) {
        const data = await res.json();
        setTheme(data.theme || 'dark');
        setColorPalette((data.color_palette === '#d0bcff' ? '#4CAF50' : data.color_palette) || '#4CAF50');
        setAvatar(data.avatar || null);
        setRole(data.role || 'user');
        setProfileData({
          id: data.id || null,
          first_name: data.first_name || '',
          last_name: data.last_name || '',
          email: data.email || '',
          location: data.location || '',
          font_family: data.font_family || '',
          public_key: data.public_key || null
        });
        
        if (!data.first_name || !data.first_name.trim()) {
          setShowOnboarding(true);
        }

        localStorage.setItem('theme', data.theme || 'dark');
        localStorage.setItem('colorPalette', (data.color_palette === '#d0bcff' ? '#4CAF50' : data.color_palette) || '#4CAF50');
        localStorage.setItem('role', data.role || 'user');
        if (data.avatar) localStorage.setItem('avatar', data.avatar);
        else localStorage.removeItem('avatar');
      }
    } catch (err) {
      console.error('Failed to fetch profile', err);
    }
  };

  useEffect(() => {
    if (token) fetchProfile();
  }, [token]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const verifyToken = params.get('token');
    if (window.location.pathname === '/verify' && verifyToken) {
      fetch(`${socketUrl}/api/verify?token=${verifyToken}`)
        .then(res => res.json())
        .then(data => {
          if (data.message) {
            setAuthSuccess(data.message);
            setAuthMode('login');
          } else if (data.error) {
            setAuthError(data.error);
          }
          window.history.replaceState({}, document.title, '/');
        })
        .catch(err => {
          setAuthError('Verification failed. Server unreachable.');
          window.history.replaceState({}, document.title, '/');
        });
    } else if (window.location.pathname === '/reset-password' && verifyToken) {
      setAuthMode('reset');
      setResetToken(verifyToken);
      window.history.replaceState({}, document.title, '/');
    }

    // Deep-link from push notification: ?space=ID
    const deepSpaceId = params.get('space');
    if (deepSpaceId) {
      window._pendingDeepSpaceId = Number(deepSpaceId);
      window.history.replaceState({}, document.title, '/');
    }
  }, []);

  // Consume deep-link once spaces are loaded
  useEffect(() => {
    if (window._pendingDeepSpaceId && spaces.length > 0) {
      const target = spaces.find(s => Number(s.id) === Number(window._pendingDeepSpaceId));
      if (target) {
        setCurrentSpace(target);
        setMobileView('chat');
      }
      delete window._pendingDeepSpaceId;
    }
  }, [spaces]);

  useEffect(() => {
    const checkJoinLink = async () => {
      const path = window.location.pathname;
      if (path.startsWith('/join/') && token && isConnected) {
        const inviteKey = path.split('/join/')[1];
        if (inviteKey) {
          try {
            const res = await fetch(`${socketUrl}/api/spaces/join/${inviteKey}`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            if (res.ok || data.message === 'Already a member') {
              if (data.space) {
                setSpaces(prev => {
                  if (!prev.find(s => s.id === data.space.id)) return [...prev, data.space];
                  return prev;
                });
                setCurrentSpace(data.space);
              }
            } else {
              alert(data.error || 'Failed to join space');
            }
          } catch (err) {
            console.error('Join error', err);
          } finally {
            window.history.replaceState(null, '', '/');
          }
        }
      }
    };
    checkJoinLink();
  }, [token, isConnected]);

  const fetchLocationSuggestions = async (query) => {
    if (!query || query.trim().length < 2) {
      setLocationSuggestions([]);
      return;
    }
    try {
      const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=en`);
      if (res.ok) {
        const data = await res.json();
        if (!data.results) { setLocationSuggestions([]); return; }
        const suggestions = data.results.map(f => {
          const parts = [f.name, f.admin1, f.country].filter(Boolean);
          return parts.join(', ');
        });
        setLocationSuggestions([...new Set(suggestions)]);
      }
    } catch (err) {
      console.error('Geocoding search error:', err);
    }
  };

  const handleLocationChange = (val) => {
    setProfileData({ ...profileData, location: val });
    setShowSuggestions(true);
    
    if (locationTimeoutRef.current) clearTimeout(locationTimeoutRef.current);
    locationTimeoutRef.current = setTimeout(() => {
      fetchLocationSuggestions(val);
    }, 400);
  };

  const saveProfileSettings = async (overrides = {}) => {
    try {
      await fetch(`${socketUrl}/api/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ 
          theme, 
          color_palette: colorPalette, 
          avatar,
          ...profileData,
          ...overrides 
        })
      });
    } catch (e) {
      console.error('Failed to save profile on backend', e);
    }
  };

  const handleThemeChange = (newTheme) => {
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    saveProfileSettings({ theme: newTheme });
  };

  const handlePaletteChange = (newPalette) => {
    setColorPalette(newPalette);
    localStorage.setItem('colorPalette', newPalette);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      saveProfileSettings({ color_palette: newPalette });
    }, 500);
  };

  const handleAvatarChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setCroppingImage(event.target.result);
      };
      reader.readAsDataURL(file);
    }
  };

  const onCropComplete = async (croppedBase64) => {
    setAvatar(croppedBase64);
    setCroppingImage(null);
    localStorage.setItem('avatar', croppedBase64);
    saveProfileSettings({ avatar: croppedBase64 });
  };
  
  const handleAssetUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    e.target.value = ''; // Reset input immediately
    setIsUploadingMedia(true);
    setPendingAsset(null);

    const formData = new FormData();
    formData.append('asset', file);

    try {
      const res = await fetch(`${socketUrl}/api/upload?token=${token}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });
      const data = await res.json();
      if (res.ok && data.url) {
        setPendingAsset(data.url);
      } else {
        alert(data.error || 'Upload failed');
      }
    } catch (err) {
      console.error('Upload error:', err);
      alert('Upload failed due to network error.');
    } finally {
      setIsUploadingMedia(false);
    }
  };

  const createSpace = async (e) => {
    e.preventDefault();
    if (!newSpaceName.trim() || isCreatingSpace) return;
    setIsCreatingSpace(true);

    let keyShares = {};
    let roomKeyObj = null;

    if (privateKeyRef.current && profileData.public_key) {
      try {
        roomKeyObj = await generateRoomKey();

        // 1. Generate encrypted share for the creator
        const creatorId = allUsers.find(u => u.username === username)?.id;
        if (!creatorId) {
          throw new Error('Creator ID lookup failed in allUsers list.');
        }
        
        const ourEncrypted = await encryptRoomKeyWithPublicKey(roomKeyObj, profileData.public_key);
        keyShares[creatorId] = ourEncrypted;

        // 2. Generate encrypted shares for all invited users
        if (invitedUsers && invitedUsers.length > 0) {
          for (const uId of invitedUsers) {
            const userObj = allUsers.find(u => u.id === Number(uId));
            if (userObj && userObj.public_key) {
               const peerEnc = await encryptRoomKeyWithPublicKey(roomKeyObj, userObj.public_key);
               keyShares[uId] = peerEnc;
            }
          }
        }
      } catch (keyErr) {
        console.error("Failed to generate Room Key matrix", keyErr);
        alert('E2EE Setup Failed: Check console. Make sure user profiles are loaded.');
        setIsCreatingSpace(false);
        return;
      }
    } else {
      alert("Your E2EE Identity is missing. Log out and back in to sync it.");
      setIsCreatingSpace(false);
      return;
    }

    try {
      const res = await fetch(`${socketUrl}/api/spaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ name: newSpaceName, is_private: isNewSpacePrivate, invited_users: invitedUsers, keyShares })
      });
      if (res.ok) {
        const newSpace = await res.json();
        
        if (roomKeyObj) {
          setActiveKeys(prev => ({ ...prev, [newSpace.id]: roomKeyObj }));
          await syncRoomKeyToIDB(newSpace.id, roomKeyObj);
        }

        setSpaces(prev => {
          if (!prev.find(s => s.id === newSpace.id)) return [...prev, newSpace];
          return prev;
        });
        setNewSpaceName('');
        setIsNewSpacePrivate(false);
        setInvitedUsers([]);
        setCurrentSpace(newSpace);
        setShowSpaceModal(false);
        setShowSidebar(false);
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to create space');
      }
    } catch (err) { 
      console.error('Failed to create space', err);
      alert('Network error while creating space. Please try again.');
    } finally {
      setIsCreatingSpace(false);
    }
  };

  const deleteSpace = async (id) => {
    try {
      const res = await fetch(`${socketUrl}/api/spaces/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        setSpaces(prev => prev.filter(s => s.id !== id));
        if (currentSpace.id === id) {
          setCurrentSpace(spaces.find(s => s.is_dm === 1 && s.name.startsWith('self_')) || spaces[0] || { id: null, name: 'Loading...' });
        }
        setSpaceToDelete(null);
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to delete space');
        setSpaceToDelete(null);
      }
    } catch (err) { console.error('Failed to delete space', err); setSpaceToDelete(null); }
  };

  const leaveSpace = async (id) => {
    try {
      const res = await fetch(`${socketUrl}/api/spaces/${id}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({})
      });
      if (res.ok) {
        setSpaces(prev => prev.filter(s => s.id !== id));
        if (currentSpace.id === id) {
          setCurrentSpace(spaces.find(s => s.is_dm === 1 && s.name.startsWith('self_')) || spaces[0] || { id: null, name: 'Loading...' });
        }
        setSpaceToLeave(null);
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to leave space');
        setSpaceToLeave(null);
      }
    } catch (err) { console.error('Failed to leave space', err); setSpaceToLeave(null); }
  };

  const removeUserFromSpace = async (userId) => {
    if (!window.confirm('Remove this user from the space?')) return;
    try {
      const res = await fetch(`${socketUrl}/api/spaces/${currentSpace.id}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ userId })
      });
      if (res.ok) {
        setAlreadyInvited(prev => prev.filter(id => id !== userId));
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to remove user');
      }
    } catch (err) { console.error('Failed to remove user', err); }
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('username');
    localStorage.removeItem('avatar');
    localStorage.removeItem('role');
    localStorage.removeItem('prado_decryption_key');
    purgeCryptoIDB();
    setRole('user');
    setToken(null);
    setUsername('');
    setAvatar(null);
    setMessages([]);
    setCurrentSpace({ id: null, name: 'Loading...' });
    setSpaces([]);
    if (socket) socket.disconnect();
  }

  const searchGiphy = async () => {
    if (!gifSearch.trim()) return;
    try {
      const res = await fetch(`${socketUrl}/api/gifs?q=${encodeURIComponent(gifSearch)}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      setGifs(data);
    } catch(err) { console.error('Giphy error', err); }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      if (showGifPicker && gifSearch.trim().length >= 2) {
        searchGiphy();
      } else if (!gifSearch.trim()) {
        setGifs([]);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [gifSearch, showGifPicker]);

  const sendGif = (url) => {
    if (socket && isConnected) {
      socket.emit('chat message', { text: '', spaceId: currentSpace.id, asset: url });
      setShowGifPicker(false);
      setGifSearch('');
      setGifs([]);
    }
  };

  const sendMessage = async (e) => {
    e.preventDefault();
    if ((input.trim() || pendingAsset) && socket && isConnected) {
      const el = richInputRef.current;
      let payloadText = el ? serializeToMarkdown(el) : input;
      
      const spaceObj = currentSpace;
      if (!spaceObj || !spaceObj.id) return;
      
      if (isEncryptedSpace(spaceObj) && !activeKeys[spaceObj.id]) {
         alert("Encryption Key missing. Security context unavailable. Message blocked.");
         return;
      }
      if (payloadText.trim()) {
         try {
           if (isEncryptedSpace(spaceObj)) {
             payloadText = await encryptMessage(payloadText, activeKeys[spaceObj.id]);
           }
         } catch (err) {
           console.error("Encryption failed:", err);
           alert("Failed to encrypt message natively. Aborting transmission.");
           return;
         }
      }

      socket.emit('chat message', { text: payloadText, spaceId: spaceObj.id, asset: pendingAsset });
      setInput('');
      if (el) { el.innerHTML = ''; el.style.height = 'auto'; }
      setPendingAsset(null);
      socket.emit('stop typing', spaceObj.id);
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    }
  };

  const handleReaction = (msgId, emoji) => {
    socket.emit('react message', { id: msgId, spaceId: currentSpace.id, emoji });
    setReactingToMsgId(null);
  };

  const pinMessage = (msgId, isPinnedValue) => {
    socket.emit('pin message', { id: msgId, spaceId: currentSpace.id, is_pinned: isPinnedValue });
  };

  const handleTyping = () => {
    const el = richInputRef.current;
    if (!el) return;
    // Auto-detect markdown shortcuts (e.g., **bold** → <strong>bold</strong>)
    processMarkdownShortcuts(el);
    setInput(serializeToMarkdown(el));
    if (!socket || !isConnected) return;
    
    socket.emit('typing', { spaceId: currentSpace.id, avatar });
    
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      socket.emit('stop typing', { spaceId: currentSpace.id });
    }, 1500);
  };

  const startEditing = (msg) => {
    setEditingId(msg.id);
    setEditInput(msg.text);
    // Populate the contentEditable edit div after it mounts
    requestAnimationFrame(() => {
      const el = editInputRef.current;
      if (el) {
        el.innerHTML = renderMarkdown(msg.text);
        processAllMarkdownInNode(el);
        el.focus();
        // Place cursor at end
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });
  };

  const saveEdit = async (e) => {
    e.preventDefault();
    const el = editInputRef.current;
    const editText = el ? serializeToMarkdown(el) : editInput;
    if (editText.trim() && socket && isConnected) {
      let payloadText = editText;
      const spaceObj = currentSpace;
      
      if (isEncryptedSpace(spaceObj)) {
        if (!activeKeys[spaceObj.id]) {
           alert("Encryption Key missing. Security context unavailable. Message blocked.");
           return;
        }
        try {
           payloadText = await encryptMessage(payloadText, activeKeys[spaceObj.id]);
        } catch (err) {
           console.error("Encryption failed:", err);
           alert("Failed to encrypt message.");
           return;
        }
      }

      socket.emit('edit message', { id: editingId, text: payloadText, spaceId: currentSpace.id });
      setEditingId(null);
      setEditInput('');
    }
  };

  const deleteMessage = (id) => {
    if (socket && isConnected) {
      socket.emit('delete message', { id, spaceId: currentSpace.id });
      setMsgToDelete(null);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const el = richInputRef.current;
      const currentText = el ? serializeToMarkdown(el) : input;
      if ((currentText.trim() || pendingAsset) && socket && isConnected) {
        sendMessage(e);
      }
      return;
    }
    if (e.key === 'ArrowUp' && input === '' && messages.length > 0) {
      const myMessages = messages.filter(m => m.sender === username);
      if (myMessages.length > 0) {
        startEditing(myMessages[myMessages.length - 1]);
      }
    }
  };

  // Auth UI Render
  if (!token) {
    return (
      <div className="auth-wrapper" data-theme={theme} style={dynamicStyles}>
        <div className="auth-card">
          <img src="/icon.png" alt="Logo" style={{ width: '80px', height: '80px', marginBottom: '1rem', borderRadius: '16px' }} />
          <h1>Prado Chat</h1>
          <form onSubmit={handleAuth}>
            <div className="input-group">
              {(authMode === 'login' || authMode === 'register' || authMode === 'forgot') && (
                <div className="material-input-wrapper">
                  <input
                    type="email"
                    className="material-input"
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    required
                    placeholder=" "
                    id="auth-email"
                    name="email"
                    autoComplete="email"
                  />
                  <label htmlFor="auth-email" className="material-label">Email Address</label>
                </div>
              )}
              {authMode !== 'forgot' && (
                <div className="material-input-wrapper" style={{ position: 'relative' }}>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    className="material-input"
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    required
                    placeholder=" "
                    id="auth-pass"
                    name="password"
                    autoComplete={authMode === 'register' ? 'new-password' : 'current-password'}
                    style={{ paddingRight: '44px' }}
                  />
                  <label htmlFor="auth-pass" className="material-label">Password{authMode === 'reset' ? ' (New)' : ''}</label>
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    style={{
                      position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)',
                      background: 'none', border: 'none', color: 'var(--md-sys-color-on-background)', opacity: 0.6,
                      cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center'
                    }}
                    tabIndex="-1"
                  >
                    {showPassword ? (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>
                    ) : (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                    )}
                  </button>
                </div>
              )}
            </div>
            {authMode === 'login' && (
              <div style={{ textAlign: 'right', marginTop: '-0.5rem', marginBottom: '1rem' }}>
                <span onClick={() => { setAuthMode('forgot'); setAuthError(''); setAuthSuccess(''); }} style={{ fontSize: '0.8rem', color: 'var(--md-sys-color-primary)', cursor: 'pointer', fontWeight: 500 }}>Forgot Password?</span>
              </div>
            )}
            {authSuccess && <p style={{ color: 'var(--md-sys-color-primary)', fontSize: '0.875rem', marginBottom: '1rem', fontWeight: 600 }}>{authSuccess}</p>}
            {authError && <p style={{ color: '#ffb4ab', fontSize: '0.875rem', marginBottom: '1rem', fontWeight: 600 }}>{authError}</p>}
            <button type="submit" className="btn-primary" style={{ width: '100%' }}>
              {authMode === 'login' ? 'Sign In' : authMode === 'register' ? 'Create Account' : authMode === 'forgot' ? 'Send Reset Link' : 'Set New Password'}
            </button>
          </form>
          {authMode === 'forgot' || authMode === 'reset' ? (
            <p style={{ marginTop: '2rem', fontSize: '0.875rem', color: 'var(--md-sys-color-outline)' }}>
              <span onClick={() => { setAuthMode('login'); setAuthError(''); setAuthSuccess(''); }} style={{ color: 'var(--md-sys-color-primary)', cursor: 'pointer', fontWeight: '500' }}>Back to Login</span>
            </p>
          ) : (
            <p style={{ marginTop: '2rem', fontSize: '0.875rem', color: 'var(--md-sys-color-outline)' }}>
              {authMode === 'login' ? "Don't have an account? " : "Already have an account? "}
              <span
                onClick={() => {
                  setAuthMode(authMode === 'login' ? 'register' : 'login');
                  setAuthError('');
                  setAuthSuccess('');
                }}
                style={{ color: 'var(--md-sys-color-primary)', cursor: 'pointer', fontWeight: '500' }}
              >
                {authMode === 'login' ? 'Sign up' : 'Log in'}
              </span>
            </p>
          )}
        </div>
      </div>
    );
  }

  // Chat UI Render
  const getSpaceDisplayName = (spaceObj = currentSpace) => {
    if (!spaceObj) return '';
    if (spaceObj.is_dm !== 1) return spaceObj.name;
    if (spaceObj.name.startsWith('self_')) return `${profileData.first_name || username} (Notes to Self)`;
    return spaceObj.dm_first ? `${spaceObj.dm_first} ${spaceObj.dm_last || ''}`.trim() : (spaceObj.dm_username || 'Direct Message');
  };

  return (
    <>
      {showOnboarding ? (
        <div className="auth-wrapper" data-theme={theme} style={dynamicStyles}>
          <div className="auth-card" style={{ maxWidth: '500px', width: '100%', padding: '2rem' }}>
            <img src="/icon.png" alt="Logo" style={{ width: '64px', height: '64px', marginBottom: '1rem', borderRadius: '12px' }} />
            <h2 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>Welcome to Prado Chat</h2>
            <p style={{ color: 'var(--md-sys-color-outline)', marginBottom: '2rem' }}>Let's set up your new profile before you join.</p>
            <form onSubmit={async (e) => {
              e.preventDefault();
              if (!profileData.first_name.trim() || !profileData.last_name.trim()) return;
              await saveProfileSettings();
              setShowOnboarding(false);
            }} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', textAlign: 'left' }}>
              <div className="material-input-wrapper">
                <input type="text" id="ob-first" className="material-input" placeholder=" " required value={profileData.first_name} onChange={(e) => setProfileData({...profileData, first_name: e.target.value})} />
                <label htmlFor="ob-first" className="material-label">First Name</label>
              </div>
              <div className="material-input-wrapper">
                <input type="text" id="ob-last" className="material-input" placeholder=" " required value={profileData.last_name} onChange={(e) => setProfileData({...profileData, last_name: e.target.value})} />
                <label htmlFor="ob-last" className="material-label">Last Name</label>
              </div>
              <div className="material-input-wrapper" style={{ position: 'relative', zIndex: showSuggestions ? 100 : 1 }}>
                <input type="text" id="ob-loc" className="material-input" placeholder=" " value={profileData.location} onChange={(e) => handleLocationChange(e.target.value)} onBlur={() => setTimeout(() => setShowSuggestions(false), 200)} />
                <label htmlFor="ob-loc" className="material-label">Location (Optional)</label>
                {showSuggestions && locationSuggestions.length > 0 && (
                  <div className="location-suggestions">
                    {locationSuggestions.map((s, idx) => (
                      <div key={idx} className="suggestion-item" onClick={() => { setProfileData({ ...profileData, location: s }); saveProfileSettings({ location: s }); setShowSuggestions(false); }}>
                        {s}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <button type="submit" className="btn-primary" style={{ width: '100%', padding: '0.85rem', marginTop: '1rem' }}>Complete Setup</button>
            </form>
          </div>
        </div>
      ) : (
        // Main UI Container
        <div className={`app-container ${mobileView === 'list' ? 'show-list' : 'show-chat'}`} data-theme={theme} style={dynamicStyles}>
      
      {/* Sidebar Overlay - Legacy/Optional depending on CSS */}
      <div
        className={`sidebar-overlay ${showSidebar ? 'active' : ''}`}
        onClick={() => setShowSidebar(false)}
      ></div>

      {/* Universal Top App Bar */}
      <div className="top-app-bar">
         <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <img src="/icon.png" alt="Logo" style={{ width: '32px', height: '32px', borderRadius: '6px' }} />
            <h1 style={{ fontSize: '1.25rem', margin: 0, fontWeight: '500', color: 'var(--md-sys-color-on-surface)', letterSpacing: '0.15px' }}>Prado Chat</h1>
         </div>
         
         <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
           {weather && (
             <div className="weather-widget" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', color: 'var(--md-sys-color-on-surface-variant)', userSelect: 'none' }} title={`Weather in ${profileData.location}`}>
               <WeatherIcon type={weather.icon} />
               {weather.temp}°
             </div>
           )}
           <button 
             onClick={() => setShowSettings(true)}
             className="icon-btn"
             title="Settings"
             style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '36px', height: '36px', borderRadius: '50%', backgroundColor: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--md-sys-color-on-surface-variant)', transition: 'background-color 0.2s' }}
             onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--md-sys-color-surface-variant)'}
             onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
           >
             <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
           </button>
           <div className="auth-actions" ref={dropdownRef} style={{ position: 'relative' }}>
             <button
               onClick={() => setShowDropdown(!showDropdown)}
               style={{ cursor: 'pointer', border: `2px solid ${isConnected ? 'var(--md-sys-color-primary)' : '#dc3545'}`, display: 'flex', alignItems: 'center', padding: '2px', justifyContent: 'center', borderRadius: '50%', backgroundColor: 'transparent', transition: 'all 0.2s', width: '36px', height: '36px', outline: 'none' }}
               title={isConnected ? "Profile Menu" : "Disconnected"}
             >
               {isConnected && avatar ? (
                 <img src={avatar} style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} alt="Avatar" />
               ) : isConnected ? (
                 <div style={{ width: '100%', height: '100%', borderRadius: '50%', backgroundColor: 'var(--md-sys-color-primary)', color: 'var(--md-sys-color-on-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1rem', fontWeight: 'bold' }}>
                   {profileData.first_name ? profileData.first_name.charAt(0).toUpperCase() : username.charAt(0).toUpperCase()}
                 </div>
               ) : (
                 <div style={{ width: '100%', height: '100%', borderRadius: '50%', backgroundColor: '#fce8e8', color: '#dc3545', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                   <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                 </div>
               )}
             </button>

             {showDropdown && (
               <div className="user-dropdown">
                 {role === 'admin' && (
                   <button onClick={() => { setShowAdminPanel(true); setShowDropdown(false); }} className="dropdown-item" style={{ color: 'var(--md-sys-color-primary)', fontWeight: 'bold' }}>Admin Panel</button>
                 )}
                 {deferredPrompt && (
                   <button onClick={() => { handleInstallClick(); setShowDropdown(false); }} className="dropdown-item">Install App</button>
                 )}
                 <button onClick={() => { handleLogout(); setShowDropdown(false); }} className="dropdown-item danger">Logout</button>
               </div>
             )}
           </div>
         </div>
      </div>

      {/* LEFT PANE: Sidebar */}
      <div className={`sidebar ${showSidebar ? 'open' : ''}`}>
        
        {promptNotification && (
          <div style={{ backgroundColor: 'var(--md-sys-color-primary)', color: 'var(--md-sys-color-on-primary)', padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '0.85rem', zIndex: 50, borderBottom: '1px solid rgba(0,0,0,0.1)' }}>
            <div style={{ fontWeight: 600 }}>Enable Desktop Notifications?</div>
            <div style={{ display: 'flex', gap: '12px' }}>
              <button style={{ background: 'var(--md-sys-color-on-primary)', color: 'var(--md-sys-color-primary)', border: 'none', padding: '4px 12px', borderRadius: '4px', fontWeight: 'bold', cursor: 'pointer' }} onClick={async () => { await togglePushNotifications(); setPromptNotification(false); }}>Enable</button>
              <button style={{ background: 'transparent', border: '1px solid var(--md-sys-color-on-primary)', color: 'inherit', padding: '4px 12px', borderRadius: '4px', cursor: 'pointer' }} onClick={() => setPromptNotification(false)}>Dismiss</button>
            </div>
          </div>
        )}
        
        {/* Start Chat Button */}
        <div style={{ padding: '16px 20px 8px 20px', position: 'relative' }} ref={startChatRef}>
          <button 
            className="btn-primary" 
            style={{ width: '100%', padding: '12px', fontSize: '0.95rem', borderRadius: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', boxShadow: 'none' }}
            onClick={() => setShowStartChatMenu(!showStartChatMenu)}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
            Start chat
          </button>

          {showStartChatMenu && (
             <div style={{ position: 'absolute', top: 'calc(100% - 4px)', left: '20px', right: '20px', backgroundColor: 'var(--md-sys-color-surface-container-high)', borderRadius: '12px', padding: '8px', zIndex: 100, boxShadow: '0 8px 16px rgba(0,0,0,0.5)', border: '1px solid var(--md-sys-color-outline-variant)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <button 
                  className="media-option" 
                  onClick={() => { 
                    setShowStartChatMenu(false); 
                    if (allUsers.length === 0) fetch(`${socketUrl}/api/users`, { headers: { 'Authorization': `Bearer ${token}` } }).then(res => res.json()).then(data => setAllUsers(data.filter(u => u.username !== username)));
                    setShowSpaceModal(true); 
                  }}
                  style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', borderRadius: '8px', cursor: 'pointer', border: 'none', background: 'none', color: 'var(--md-sys-color-on-surface)', width: '100%', textAlign: 'left', transition: 'background-color 0.2s', fontWeight: 500 }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                  Create a Space
                </button>
                <button 
                  className="media-option" 
                  onClick={() => { 
                    setShowStartChatMenu(false); 
                    if (allUsers.length === 0) fetch(`${socketUrl}/api/users`, { headers: { 'Authorization': `Bearer ${token}` } }).then(res => res.json()).then(data => setAllUsers(data.filter(u => u.username !== username)));
                    setShowDMModal(true); 
                  }}
                  style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', borderRadius: '8px', cursor: 'pointer', border: 'none', background: 'none', color: 'var(--md-sys-color-on-surface)', width: '100%', textAlign: 'left', transition: 'background-color 0.2s', fontWeight: 500 }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
                  New Direct Message
                </button>
             </div>
          )}
        </div>

        <div className="space-list" style={{ flex: 1, overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0px 20px 8px 20px' }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--md-sys-color-outline)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Spaces</div>
            <button 
              className="icon-btn"
              onClick={(e) => {
                e.stopPropagation();
                if (allUsers.length === 0) {
                  fetch(`${socketUrl}/api/users`, { headers: { 'Authorization': `Bearer ${token}` } })
                    .then(res => res.json())
                    .then(data => setAllUsers(data.filter(u => u.username !== username)));
                }
                setShowSpaceModal(true);
              }}
              title="Create Space"
              style={{ width: '24px', height: '24px', padding: '0', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--md-sys-color-outline)' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            </button>
          </div>
          {spaces.filter(s => s.is_dm !== 1).map(space => (
            <div
              key={space.id}
              className={`space-item ${currentSpace.id === space.id ? 'active' : ''}`}
              onClick={() => handleSpaceSelect(space)}
            >
              <span className="space-name" style={{ display: 'flex', alignItems: 'center' }}>
                {space.is_private === 1 ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '6px', opacity: 0.7 }}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg> : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '6px', opacity: 0.5 }}><line x1="4" y1="9" x2="20" y2="9"></line><line x1="4" y1="15" x2="20" y2="15"></line><line x1="10" y1="3" x2="8" y2="21"></line><line x1="16" y1="3" x2="14" y2="21"></line></svg>}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{space.name}</span>
                {unreadCounts[space.id] > 0 && <span style={{ marginLeft: '8px', backgroundColor: 'var(--md-sys-color-primary)', color: 'var(--md-sys-color-on-primary)', fontSize: '0.7rem', fontWeight: 'bold', padding: '2px 6px', borderRadius: '12px' }}>{unreadCounts[space.id]}</span>}
              </span>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <button className="delete-space-btn" style={{ color: 'var(--md-sys-color-outline)' }} onClick={(e) => { e.stopPropagation(); setActiveSpaceMenu(activeSpaceMenu === space.id ? null : space.id); }} title="Space Options">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg>
                </button>
                {activeSpaceMenu === space.id && (
                  <div ref={spaceMenuRef} style={{ position: 'absolute', top: '100%', right: 0, backgroundColor: 'var(--md-sys-color-surface-container-high)', borderRadius: '8px', padding: '4px', zIndex: 110, boxShadow: '0 4px 12px rgba(0,0,0,0.3)', border: '1px solid var(--md-sys-color-outline-variant)', minWidth: '150px' }}>
                    {(role === 'admin' || username === space.created_by) && !(space.is_dm === 1 && space.name.startsWith('self_')) && (
                      <button className="dropdown-item danger" onClick={(e) => { e.stopPropagation(); setSpaceToDelete(space); setActiveSpaceMenu(null); }} style={{ width: '100%', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px' }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                        Delete Space
                      </button>
                    )}
                    {role !== 'admin' && username !== space.created_by && (space.is_private == 1 || space.is_private === true || space.is_private === '1') && (
                      <button className="dropdown-item" onClick={(e) => { e.stopPropagation(); setSpaceToLeave(space); setActiveSpaceMenu(null); }} style={{ width: '100%', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px' }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
                        Leave Space
                      </button>
                    )}
                    {!(role === 'admin' || username === space.created_by) && !(role !== 'admin' && username !== space.created_by && (space.is_private == 1 || space.is_private === true || space.is_private === '1')) && (
                       <div style={{ padding: '8px 12px', fontSize: '0.85rem', color: 'var(--md-sys-color-outline)', textAlign: 'center' }}>No actions</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '24px 20px 8px 20px' }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--md-sys-color-outline)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Direct Messages</div>
            <button 
              className="icon-btn"
              onClick={(e) => {
                e.stopPropagation();
                if (allUsers.length === 0) {
                  fetch(`${socketUrl}/api/users`, { headers: { 'Authorization': `Bearer ${token}` } })
                    .then(res => res.json())
                    .then(data => setAllUsers(data.filter(u => u.username !== username)));
                }
                setShowDMModal(true);
              }}
              title="New DM"
              style={{ width: '24px', height: '24px', padding: '0', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--md-sys-color-outline)' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            </button>
          </div>
          {spaces.filter(s => s.is_dm === 1).map(space => {
            const isSelf = space.name.startsWith('self_');
            const displayName = isSelf ? `${profileData.first_name || username} (You)` : (space.dm_first ? `${space.dm_first} ${space.dm_last || ''}`.trim() : space.dm_username);
            const displayAvatar = isSelf ? avatar : space.dm_avatar;
            const isOnline = isSelf || onlineUsers.some(u => u.username === space.dm_username);
            
            return (
              <div
                key={space.id}
                className={`space-item ${currentSpace.id === space.id ? 'active' : ''}`}
                onClick={() => handleSpaceSelect(space)}
                style={{ padding: '8px 20px' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%' }}>
                  <div style={{ position: 'relative', display: 'flex' }}>
                    {displayAvatar ? (
                      <img src={displayAvatar} style={{ width: '24px', height: '24px', borderRadius: '50%', objectFit: 'cover' }} alt="Avatar" />
                    ) : (
                      <div style={{ width: '24px', height: '24px', borderRadius: '50%', backgroundColor: 'var(--md-sys-color-surface-variant)', color: 'var(--md-sys-color-on-surface-variant)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem', fontWeight: 'bold' }}>
                        {displayName ? displayName.charAt(0).toUpperCase() : '?'}
                      </div>
                    )}
                    <div style={{ position: 'absolute', bottom: '-2px', right: '-2px', width: '10px', height: '10px', borderRadius: '50%', backgroundColor: isOnline ? '#4CAF50' : 'var(--md-sys-color-outline-variant)', border: '2px solid var(--md-sys-color-surface)', zIndex: 10 }}></div>
                  </div>
                  <span className="space-name" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</span>
                    {unreadCounts[space.id] > 0 && <span style={{ marginLeft: '8px', backgroundColor: 'var(--md-sys-color-primary)', color: 'var(--md-sys-color-on-primary)', fontSize: '0.7rem', fontWeight: 'bold', padding: '2px 6px', borderRadius: '12px' }}>{unreadCounts[space.id]}</span>}
                  </span>
                  <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                    <button className="delete-space-btn" style={{ color: 'var(--md-sys-color-outline)' }} onClick={(e) => { e.stopPropagation(); setActiveSpaceMenu(activeSpaceMenu === space.id ? null : space.id); }} title="Space Options">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg>
                    </button>
                    {activeSpaceMenu === space.id && (
                      <div ref={spaceMenuRef} style={{ position: 'absolute', top: '100%', right: 0, backgroundColor: 'var(--md-sys-color-surface-container-high)', borderRadius: '8px', padding: '4px', zIndex: 110, boxShadow: '0 4px 12px rgba(0,0,0,0.3)', border: '1px solid var(--md-sys-color-outline-variant)', minWidth: '150px' }}>
                        {(role === 'admin' || username === space.created_by) && !isSelf ? (
                          <button className="dropdown-item danger" onClick={(e) => { e.stopPropagation(); setSpaceToDelete(space); setActiveSpaceMenu(null); }} style={{ width: '100%', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px' }}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                            Delete Space
                          </button>
                        ) : (
                           <div style={{ padding: '8px 12px', fontSize: '0.85rem', color: 'var(--md-sys-color-outline)', textAlign: 'center' }}>No actions</div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>


      </div>

      {/* RIGHT PANE: Chat Area */}
      <div className="chat-area">
        {currentSpace ? (
          <>
            {/* Space Context Header */}
            <header className="space-header" style={{ padding: '12px 24px', display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--md-sys-color-surface-variant)', backgroundColor: 'var(--md-sys-color-surface)' }}>
              
              {/* Mobile Only Native Back Button mapped to CSS media toggles */}
              <button 
                className="icon-btn mobile-back-btn" 
                onClick={() => setMobileView('list')}
                title="Back to Conversations"
              >
                 <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
              </button>
              
              <div style={{ flex: 1 }}>
                <h2 style={{ fontSize: '1.25rem', margin: 0, fontWeight: '500', display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {getSpaceDisplayName()}
                  {currentSpace.is_private === 1 && currentSpace.is_dm !== 1 && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: '4px', opacity: 0.6 }}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>}
                </h2>
              </div>

              <div className="space-actions" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                 {isConnected && (
                   <button
                     onClick={() => setShowPinnedBoard(prev => !prev)}
                     title="Pinned Messages"
                     style={{ background: showPinnedBoard ? 'var(--md-sys-color-primary-container)' : 'none', border: 'none', color: showPinnedBoard ? 'var(--md-sys-color-on-primary-container)' : 'var(--md-sys-color-outline)', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: '8px', transition: 'all 0.2s', borderRadius: '50%' }}
                     onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--md-sys-color-on-primary-container)'; e.currentTarget.style.backgroundColor = 'var(--md-sys-color-primary-container)'; }}
                     onMouseLeave={(e) => { 
                       if (!showPinnedBoard) {
                         e.currentTarget.style.color = 'var(--md-sys-color-outline)'; 
                         e.currentTarget.style.backgroundColor = 'transparent'; 
                       }
                     }}
                   >
                     <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"><path d="M12 17v5"/><path d="M5 17h14v-2l-3-4V6a4 4 0 0 0-8 0v5l-3 4z"/></svg>
                   </button>
                 )}
                 {isConnected && !showVideoRoom && (
                   <button 
                     onClick={() => setShowVideoRoom(true)}
                     title="Join Video Call"
                     style={{ background: 'none', border: 'none', color: 'var(--md-sys-color-outline)', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: '8px', transition: 'all 0.2s', borderRadius: '50%' }}
                     onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--md-sys-color-on-primary)'; e.currentTarget.style.backgroundColor = 'var(--md-sys-color-primary)'; }}
                     onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--md-sys-color-outline)'; e.currentTarget.style.backgroundColor = 'transparent'; }}
                   >
                     <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>
                   </button>
                 )}
                 {isConnected && currentSpace.is_private === 1 && currentSpace.is_dm !== 1 && (
                   <button 
                     onClick={() => {
                       fetch(`${socketUrl}/api/users`, { headers: { 'Authorization': `Bearer ${token}` } }).then(res => res.json()).then(data => Array.isArray(data) && setAllUsers(data.filter(u => u.username !== username)));
                       fetch(`${socketUrl}/api/spaces/${currentSpace.id}/members`, { headers: { 'Authorization': `Bearer ${token}` } }).then(res => res.json()).then(data => setAlreadyInvited(data || [])).catch(() => setAlreadyInvited([]));
                       setRoomSettingsInvitedUsers([]);
                       setShowRoomSettingsModal(true);
                     }}
                     title="Room Settings"
                     style={{ background: 'none', border: 'none', color: 'var(--md-sys-color-outline)', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: '8px', transition: 'color 0.2s' }}
                     onMouseEnter={(e) => e.currentTarget.style.color = 'var(--md-sys-color-primary)'}
                     onMouseLeave={(e) => e.currentTarget.style.color = 'var(--md-sys-color-outline)'}
                   >
                     <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
                   </button>
                 )}
              </div>
            </header>

      <main className="chat-window">
        {messages.length === 0 && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.8, color: 'var(--md-sys-color-outline)' }}>
            No messages in {currentSpace.is_dm === 1 ? '' : '#'}{getSpaceDisplayName()} yet.
          </div>
        )}
        <div style={{ flex: 1 }}></div> {/* Pushes messages to bottom if few */}
        <div ref={topAnchorRef} style={{ width: '100%', height: '1px', flexShrink: 0 }}></div>
        {isFetchingHistory && (
          <div style={{ textAlign: 'center', padding: '1rem', opacity: 0.8 }}>
            <div className="spinner" style={{ width: '24px', height: '24px', margin: '0 auto', borderColor: 'var(--md-sys-color-outline)' }}></div>
          </div>
        )}
        {messages.map((msg, idx) => {
          const isMe = msg.sender === username;
          
          let showDateDivider = false;
          let dateString = '';
          if (msg.timestamp) {
            const msgDate = new Date(msg.timestamp);
            dateString = msgDate.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
            if (idx === 0) {
              showDateDivider = true;
            } else {
              const prevMsg = messages[idx - 1];
              if (prevMsg && prevMsg.timestamp) {
                const prevDate = new Date(prevMsg.timestamp).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
                if (dateString !== prevDate) showDateDivider = true;
              }
            }
          }

          return (
            <React.Fragment key={msg.id || idx}>
              {showDateDivider && (
                <div style={{ display: 'flex', alignItems: 'center', margin: '1.5rem 0', padding: '0 1rem' }}>
                  <div style={{ flex: 1, height: '1px', backgroundColor: 'var(--md-sys-color-surface-variant)' }}></div>
                  <div style={{ padding: '4px 12px', fontSize: '0.85rem', fontWeight: 600, color: 'var(--md-sys-color-on-surface-variant)', border: '1px solid var(--md-sys-color-surface-variant)', borderRadius: '16px', backgroundColor: 'var(--md-sys-color-surface)' }}>
                    {dateString}
                  </div>
                  <div style={{ flex: 1, height: '1px', backgroundColor: 'var(--md-sys-color-surface-variant)' }}></div>
                </div>
              )}
              <div className={`message-wrapper ${isMe ? 'me' : 'them'}`} id={`msg-${msg.id}`}>
                {!isMe && (
                msg.avatar ? (
                  <img loading="lazy" src={msg.avatar} style={{ width: '32px', height: '32px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0, marginBottom: '2px' }} alt={msg.first_name ? `${msg.first_name} ${msg.last_name || ''}`.trim() : msg.sender} />
                ) : (
                  <div style={{ width: '32px', height: '32px', borderRadius: '50%', backgroundColor: 'var(--md-sys-color-surface-variant)', color: 'var(--md-sys-color-on-background)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1rem', fontWeight: 'bold', flexShrink: 0, marginBottom: '2px' }}>
                    {msg.first_name ? msg.first_name.charAt(0).toUpperCase() : msg.sender.charAt(0).toUpperCase()}
                  </div>
                )
              )}
              <div className={`message ${isMe ? 'sent' : 'received'}`} onClick={() => setShowTimestampId(showTimestampId === msg.id ? null : msg.id)} style={{ cursor: 'pointer' }}>
                {Object.entries(readReceipts).filter(([u, id]) => id === msg.id && u !== username).length > 0 && (
                  <div style={{ position: 'absolute', top: '-6px', right: '-6px', display: 'flex', gap: '2px', zIndex: 10 }}>
                    {Object.entries(readReceipts)
                      .filter(([u, id]) => id === msg.id && u !== username)
                      .map(([u]) => {
                         let av = null;
                         let displayName = u;
                         const ou = onlineUsers.find(o => o.username === u);
                         if (ou) {
                           if (ou.avatar) av = ou.avatar;
                           if (ou.first_name) displayName = `${ou.first_name} ${ou.last_name || ''}`.trim();
                         }
                         if (!av || displayName === u) {
                           for (let i = messages.length - 1; i >= 0; i--) {
                             if (messages[i].sender === u) {
                               if (!av && messages[i].avatar) av = messages[i].avatar;
                               if (displayName === u && messages[i].first_name) displayName = `${messages[i].first_name} ${messages[i].last_name || ''}`.trim();
                               if (av && displayName !== u) break;
                             }
                           }
                         }
                         if (av) {
                           return <img key={u} src={av} style={{ width: '16px', height: '16px', borderRadius: '50%', objectFit: 'cover', border: '1px solid var(--md-sys-color-background)', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} title={`Read by ${displayName}`} />;
                         }
                         return <div key={u} style={{ width: '16px', height: '16px', borderRadius: '50%', backgroundColor: 'var(--md-sys-color-primary)', color: 'var(--md-sys-color-on-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '8px', fontWeight: 'bold', border: '1px solid var(--md-sys-color-background)', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} title={`Read by ${displayName}`}>{displayName.charAt(0).toUpperCase()}</div>;
                      })}
                  </div>
                )}
                {!isMe && <div className="sender-name">{msg.first_name ? `${msg.first_name} ${msg.last_name || ''}`.trim() : msg.sender}</div>}
                <div className="message-actions" style={{ display: 'flex', gap: '4px', opacity: reactingToMsgId === msg.id ? 1 : '' }}>
                  <button onClick={() => setReactingToMsgId(reactingToMsgId === msg.id ? null : msg.id)} title="React">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>
                  </button>
                  {((role === 'admin' || (currentSpace && currentSpace.created_by === username)) && !msg.asset) && (
                    <button onClick={() => pinMessage(msg.id, msg.is_pinned === 1 ? 0 : 1)} title={msg.is_pinned ? "Unpin Message" : "Pin Message"}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill={msg.is_pinned ? "currentColor" : "none"} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"><path d="M12 17v5"/><path d="M5 17h14v-2l-3-4V6a4 4 0 0 0-8 0v5l-3 4z"/></svg> 
                    </button>
                  )}
                  {isMe && !msg.asset && (
                    <button onClick={() => startEditing(msg)} title="Edit">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                    </button>
                  )}
                  {(isMe || role === 'admin' || (currentSpace && currentSpace.created_by === username)) && !msg.asset && (
                    <button onClick={() => setMsgToDelete(msg)} title="Delete" className="delete-action">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    </button>
                  )}
                </div>
                {reactingToMsgId === msg.id && (
                  <>
                    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 140 }} onClick={() => setReactingToMsgId(null)} />
                    <div className="reaction-picker-overlay" style={{ position: 'absolute', zIndex: 150, left: isMe ? 'auto' : 0, right: isMe ? 0 : 'auto', bottom: 'calc(100% + 4px)', boxShadow: '0 8px 16px rgba(0,0,0,0.5)', borderRadius: '8px' }}>
                      <EmojiPicker onEmojiClick={(emojiData) => handleReaction(msg.id, emojiData.emoji)} theme={theme === 'light' ? 'light' : 'dark'} width={300} height={400} />
                    </div>
                  </>
                )}
                {msg.asset && (
                  <div className="message-asset">
                    {msg.asset.startsWith('data:image/') || msg.asset.match(/\.(jpeg|jpg|gif|png|webp|heic|heif|bmp|svg|tiff|tif|ico)$/i) ? (
                      <img 
                        src={msg.asset.startsWith('/uploads/') ? `${socketUrl}${msg.asset}` : msg.asset} 
                        alt="Attachment" 
                        onLoad={() => scrollToBottom(isInitialLoad.current)}
                        style={{ maxWidth: '100%', maxHeight: '400px', borderRadius: '8px', marginBottom: '8px', display: 'block', objectFit: 'contain', cursor: 'pointer' }} 
                        onClick={() => setSelectedAsset(msg.asset.startsWith('/uploads/') ? `${socketUrl}${msg.asset}` : msg.asset)}
                      />
                    ) : msg.asset.startsWith('data:video/') || msg.asset.match(/\.(mp4|webm|ogg|mov|qt|3gp|avi|wmv|flv|m4v|mpg|mpeg)$/i) || msg.asset.includes('transcoded-') ? (
                      <VideoMessage src={msg.asset} />
                    ) : msg.asset.match(/\.(pdf|txt)$/i) ? (
                      <div style={{ position: 'relative', cursor: 'pointer', display: 'inline-block', width: '100%', marginBottom: '8px' }} onClick={() => setSelectedAsset(msg.asset.startsWith('/uploads/') ? `${socketUrl}${msg.asset}` : msg.asset)}>
                        <iframe src={msg.asset.startsWith('/uploads/') ? `${socketUrl}${msg.asset}#toolbar=0` : msg.asset} title="PDF Viewer" style={{ width: '100%', height: '300px', border: 'none', borderRadius: '8px', backgroundColor: '#fff', pointerEvents: 'none' }} />
                        <div style={{ position: 'absolute', top: '10px', right: '10px', backgroundColor: 'rgba(0,0,0,0.6)', color: 'white', padding: '4px 8px', borderRadius: '4px', fontSize: '0.8rem', pointerEvents: 'none' }}>Click to Fullscreen</div>
                      </div>
                    ) : (
                      <a href={msg.asset.startsWith('/uploads/') ? `${socketUrl}${msg.asset}` : msg.asset} target="_blank" rel="noopener noreferrer" download="attachment" style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px', color: 'inherit', textDecoration: 'none', backgroundColor: 'var(--md-sys-color-surface-variant)', padding: '12px', borderRadius: '12px', border: '1px solid var(--md-sys-color-outline-variant)', width: 'fit-content' }}>
                        <div style={{ width: '48px', height: '56px', backgroundColor: 'var(--md-sys-color-primary)', borderRadius: '4px 14px 4px 4px', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', boxShadow: '0 4px 12px rgba(0,0,0,0.15)', flexShrink: 0 }}>
                           <div style={{ position: 'absolute', top: '-1px', right: '-1px', width: '16px', height: '16px', backgroundColor: 'var(--md-sys-color-surface-variant)', borderBottomLeftRadius: '8px', borderLeft: '1px solid rgba(0,0,0,0.1)', borderBottom: '1px solid rgba(0,0,0,0.1)' }}></div>
                           <span style={{ color: 'var(--md-sys-color-on-primary)', fontSize: '0.75rem', fontWeight: 'bold', letterSpacing: '0.5px', marginTop: '8px', userSelect: 'none' }}>
                             {msg.asset.split('.').pop().toUpperCase().substring(0, 4)}
                           </span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                          <span style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--md-sys-color-on-surface)', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', maxWidth: '200px' }}>
                            {msg.asset.split('/').pop().replace(/^[^-]+-/, '') || 'Document'}
                          </span>
                          <span style={{ fontSize: '0.8rem', color: 'var(--md-sys-color-outline)', marginTop: '2px' }}>Click to download</span>
                        </div>
                      </a>
                    )}
                    {(isMe || role === 'admin' || (currentSpace && currentSpace.created_by === username)) && (
                      <button onClick={() => setMsgToDelete(msg)} title="Delete" className="delete-asset-btn">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                      </button>
                    )}
                  </div>
                )}
                <div className="message-content">
                  {editingId === msg.id ? (
                    <form onSubmit={saveEdit} className="edit-form">
                      <div
                        ref={editInputRef}
                        className="edit-input"
                        contentEditable
                        suppressContentEditableWarning
                        onInput={() => { const el = editInputRef.current; if (el) { processMarkdownShortcuts(el); setEditInput(serializeToMarkdown(el)); } }}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(e); } if (e.key === 'Escape') setEditingId(null); }}
                        onMouseUp={handleTextSelect}
                        onKeyUp={handleTextSelect}
                        onBlur={() => setTimeout(() => setFormatToolbar(null), 200)}
                        onPaste={(e) => { e.preventDefault(); const text = e.clipboardData.getData('text/plain'); document.execCommand('insertText', false, text); const el = editInputRef.current; if (el) { processAllMarkdownInNode(el); setEditInput(serializeToMarkdown(el)); } }}
                      />
                      <div className="edit-btns">
                        <button type="submit" className="save-btn">Save</button>
                        <button type="button" className="cancel-btn" onClick={() => setEditingId(null)}>Cancel</button>
                      </div>
                    </form>
                  ) : (
                    <>
                      {!msg.asset && <div className="message-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.text) + (msg.edited === 1 ? ' <span class="edited-badge" style="font-size:0.7em;margin-left:6px;opacity:0.6">(edited)</span>' : '') }} />}
                      {msg.reactions && msg.reactions !== '{}' && (
                        <div className="message-reactions" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
                          {Object.entries(JSON.parse(msg.reactions || '{}')).map(([emoji, usersArr]) => (
                            <div key={emoji} onClick={() => handleReaction(msg.id, emoji)} title={usersArr.map(u => { const m = messages.find(mm => mm.sender === u); return m && m.first_name ? `${m.first_name} ${m.last_name || ''}`.trim() : u; }).join(', ')} style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: usersArr.includes(username) ? 'var(--md-sys-color-primary-container)' : 'var(--md-sys-color-surface-variant)', color: usersArr.includes(username) ? 'var(--md-sys-color-on-primary-container)' : 'var(--md-sys-color-on-surface-variant)', padding: '2px 6px', borderRadius: '12px', fontSize: '0.8rem', cursor: 'pointer', border: `1px solid ${usersArr.includes(username) ? 'var(--md-sys-color-primary)' : 'transparent'}`, userSelect: 'none' }}>
                              <span>{emoji}</span>
                              <span style={{ fontWeight: '600' }}>{usersArr.length}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                  {showTimestampId === msg.id && msg.timestamp && (
                    <div style={{ fontSize: '0.7rem', opacity: 0.7, marginTop: '4px', textAlign: isMe ? 'right' : 'left', animation: 'fadeIn 0.2s ease-in' }}>
                      {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  )}
                </div>
              </div>
            </div>
            </React.Fragment>
          );
        })}
        {typingUsers.filter(u => Number(u.spaceId) === Number(currentSpace.id)).map(typer => (
          <div key={typer.username} className="message-wrapper them" style={{ animation: 'slideDownFade 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275)' }}>
            {typer.avatar ? (
              <img src={typer.avatar} style={{ width: '32px', height: '32px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0, marginBottom: '2px' }} alt={typer.username} />
            ) : (
              <div style={{ width: '32px', height: '32px', borderRadius: '50%', backgroundColor: 'var(--md-sys-color-surface-variant)', color: 'var(--md-sys-color-on-background)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1rem', fontWeight: 'bold', flexShrink: 0, marginBottom: '2px' }}>
                {typer.first_name ? typer.first_name.charAt(0).toUpperCase() : typer.username.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="message received typing-bubble" style={{ padding: '12px 14px', display: 'flex', gap: '6px', alignItems: 'center', minHeight: '40px', boxSizing: 'border-box' }}>
              <div className="typing-dot" style={{ width: '6px', height: '6px', minWidth: '6px', minHeight: '6px', backgroundColor: 'currentColor', borderRadius: '50%', opacity: 0.6, flexShrink: 0, display: 'block', animationDelay: '-0.32s' }}></div>
              <div className="typing-dot" style={{ width: '6px', height: '6px', minWidth: '6px', minHeight: '6px', backgroundColor: 'currentColor', borderRadius: '50%', opacity: 0.6, flexShrink: 0, display: 'block', animationDelay: '-0.16s' }}></div>
              <div className="typing-dot" style={{ width: '6px', height: '6px', minWidth: '6px', minHeight: '6px', backgroundColor: 'currentColor', borderRadius: '50%', opacity: 0.6, flexShrink: 0, display: 'block', animationDelay: '0s' }}></div>
            </div>
          </div>
        ))}
        <div ref={chatEndRef} />
      </main>

      {/* Absolute Slide-in Pinned Board Drawer */}
      {showPinnedBoard && (
        <div style={{
          position: 'absolute', top: '70px', right: 0, bottom: 0, width: '320px', backgroundColor: 'var(--md-sys-color-surface)',
          borderLeft: '1px solid var(--md-sys-color-surface-variant)', zIndex: 100, display: 'flex', flexDirection: 'column',
          boxShadow: '-4px 0 16px rgba(0,0,0,0.1)', animation: 'slideInRight 0.2s ease-out'
        }}>
          <div style={{ padding: '1rem', borderBottom: '1px solid var(--md-sys-color-surface-variant)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: '1.1rem', color: 'var(--md-sys-color-on-surface)' }}>Pinned Messages</h3>
            <button onClick={() => setShowPinnedBoard(false)} style={{ background: 'none', border: 'none', color: 'var(--md-sys-color-outline)', cursor: 'pointer' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {pinnedMessages.length === 0 ? (
              <div style={{ textAlign: 'center', opacity: 0.6, marginTop: '2rem' }}>No pinned messages yet.</div>
            ) : pinnedMessages.map(pm => (
              <div key={`pin-${pm.id}`} className="pinned-card" style={{ backgroundColor: 'var(--md-sys-color-surface-variant)', borderRadius: '12px', padding: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  {pm.avatar ? <img src={pm.avatar} style={{ width: '24px', height: '24px', borderRadius: '50%', objectFit: 'cover' }} /> : <div style={{ width: '24px', height: '24px', borderRadius: '50%', backgroundColor: 'var(--md-sys-color-primary)', color: 'var(--md-sys-color-on-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem', fontWeight: 'bold' }}>{pm.first_name ? pm.first_name.charAt(0).toUpperCase() : pm.sender.charAt(0).toUpperCase()}</div>}
                  <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>{pm.first_name ? `${pm.first_name} ${pm.last_name || ''}`.trim() : pm.sender}</span>
                  <span style={{ fontSize: '0.75rem', opacity: 0.7, marginLeft: 'auto' }}>{new Date(pm.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                {pm.asset && pm.asset.endsWith('.mp4') ? (
                  <video src={pm.asset} controls style={{ maxWidth: '100%', borderRadius: '8px', marginBottom: '8px' }}></video>
                ) : pm.asset ? (
                  <img src={pm.asset} style={{ maxWidth: '100%', borderRadius: '8px', marginBottom: '8px' }} alt="Pinned asset" />
                ) : null}
                <div style={{ fontSize: '0.9rem', marginBottom: '10px', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>{pm.text}</div>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button onClick={() => socket.emit('pin message', { id: pm.id, spaceId: currentSpace.id, is_pinned: 0 })} style={{ background: 'none', border: 'none', color: 'var(--md-sys-color-error)', fontSize: '0.8rem', cursor: 'pointer', fontWeight: 600 }}>Unpin</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

    <div style={{ position: 'relative' }}>
        {isUploadingMedia && (
          <div className="asset-preview" style={{ justifyContent: 'center', padding: '1.5rem', opacity: 0.8 }}>
             <div className="spinner" style={{ width: '24px', height: '24px', marginRight: '1rem' }}></div>
             <div style={{ color: 'var(--md-sys-color-primary)', fontWeight: 'bold' }}>Processing Media...</div>
          </div>
        )}
        {!isUploadingMedia && pendingAsset && (
          <div className="asset-preview">
            {pendingAsset.match(/\.(jpeg|jpg|gif|png|webp|bmp|svg)/i) ? (
              <img src={pendingAsset.startsWith('/uploads') ? `${socketUrl}${pendingAsset}` : pendingAsset} alt="Preview" />
            ) : pendingAsset.match(/\.(mp4|webm|ogg|mov|qt|3gp)/i) ? (
              <video src={pendingAsset.startsWith('/uploads') ? `${socketUrl}${pendingAsset}#t=0.001` : pendingAsset} style={{ maxWidth: '100%', maxHeight: '100px', borderRadius: '4px' }} preload="metadata" muted playsInline />
            ) : pendingAsset.match(/\.(pdf)/i) ? (
              <div className="file-preview">PDF Document Ready</div>
            ) : (
              <div className="file-preview">File Attachment Ready</div>
            )}
            <button className="cancel-asset" onClick={() => setPendingAsset(null)}>&times;</button>
          </div>
        )}

        <form className="input-area" onSubmit={sendMessage} style={{ overflow: 'visible' }}>
          <div className="media-menu-container" ref={mediaMenuRef} style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setShowMediaMenu(!showMediaMenu)}
              title="Add Media"
              style={{ backgroundColor: showMediaMenu ? 'var(--md-sys-color-surface-variant)' : 'transparent', border: 'none', cursor: 'pointer', padding: '8px', borderRadius: '50%', color: 'var(--md-sys-color-on-surface)' }}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="12" r="2"></circle>
                <circle cx="19" cy="12" r="2"></circle>
                <circle cx="5" cy="12" r="2"></circle>
              </svg>
            </button>
            
            {showMediaMenu && (
              <div className="media-popover" style={{ position: 'absolute', bottom: 'calc(100% + 12px)', left: 0, backgroundColor: 'var(--md-sys-color-surface-container-high)', borderRadius: '12px', padding: '8px', display: 'flex', flexDirection: 'column', gap: '4px', boxShadow: '0 8px 16px rgba(0,0,0,0.5)', zIndex: 100, minWidth: '160px', border: '1px solid var(--md-sys-color-outline-variant)' }}>
                <label className="media-option" style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', borderRadius: '8px', cursor: 'pointer', color: 'var(--md-sys-color-on-surface)', transition: 'background-color 0.2s', margin: 0 }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>
                  <span style={{ fontSize: '0.9rem', fontWeight: '500' }}>Upload File</span>
                  <input type="file" style={{ display: 'none' }} onChange={(e) => { handleAssetUpload(e); setShowMediaMenu(false); }} />
                </label>
                <button type="button" className="media-option" onClick={() => { setShowGifPicker(!showGifPicker); setShowEmojiPicker(false); setShowMediaMenu(false); }} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', borderRadius: '8px', cursor: 'pointer', border: 'none', background: 'none', color: 'var(--md-sys-color-on-surface)', width: '100%', textAlign: 'left', transition: 'background-color 0.2s' }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
                  <span style={{ fontSize: '0.9rem', fontWeight: '500' }}>Search GIF</span>
                </button>
                <button type="button" className="media-option" onClick={() => { setShowEmojiPicker(!showEmojiPicker); setShowGifPicker(false); setShowMediaMenu(false); }} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', borderRadius: '8px', cursor: 'pointer', border: 'none', background: 'none', color: 'var(--md-sys-color-on-surface)', width: '100%', textAlign: 'left', transition: 'background-color 0.2s' }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>
                  <span style={{ fontSize: '0.9rem', fontWeight: '500' }}>Insert Emoji</span>
                </button>
              </div>
            )}
            
            {showEmojiPicker && (
               <div style={{ position: 'absolute', bottom: 'calc(100% + 12px)', left: 0, zIndex: 200, boxShadow: '0 8px 16px rgba(0,0,0,0.5)', borderRadius: '8px' }}>
                 <EmojiPicker 
                   onEmojiClick={(emojiData) => { 
                     const el = richInputRef.current;
                     if (el) { el.focus(); document.execCommand('insertText', false, emojiData.emoji); setInput(serializeToMarkdown(el)); }
                     setShowEmojiPicker(false); 
                   }} 
                   theme={theme === 'dark' ? 'dark' : 'light'} 
                   width={300}
                   height={400}
                 />
               </div>
            )}
            
            {showGifPicker && (
               <div style={{ position: 'absolute', bottom: 'calc(100% + 12px)', left: 0, zIndex: 200, backgroundColor: 'var(--md-sys-color-surface-container-high)', border: '1px solid var(--md-sys-color-outline-variant)', borderRadius: '12px', padding: '12px', width: '320px', boxShadow: '0 8px 16px rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                 <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: '600', fontSize: '0.95rem', color: 'var(--md-sys-color-on-surface)' }}>GIF Search (Giphy)</span>
                    <button type="button" onClick={() => setShowGifPicker(false)} style={{ background: 'none', border: 'none', color: 'var(--md-sys-color-on-surface)', cursor: 'pointer', padding: '4px' }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </button>
                 </div>
                 <input 
                   type="text" 
                   placeholder="Search..." 
                   value={gifSearch} 
                   onChange={(e) => setGifSearch(e.target.value)} 
                   onKeyDown={(e) => e.key === 'Enter' && searchGiphy()} 
                   className="material-input" 
                   autoFocus
                   style={{ width: '100%', marginBottom: '8px', boxSizing: 'border-box', padding: '8px 12px' }} 
                 />
                 <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', maxHeight: '250px', overflowY: 'auto', paddingRight: '4px' }}>
                   {gifs.map(g => (
                      <img 
                        key={g.id} 
                        src={g.images?.fixed_height_small?.url || g.images?.original?.url} 
                        onClick={() => sendGif(g.images?.original?.url)} 
                        alt={g.title}
                        style={{ width: '100%', height: '100px', objectFit: 'cover', borderRadius: '4px', cursor: 'pointer' }} 
                      />
                   ))}
                   {gifs.length === 0 && gifSearch.trim() && (
                     <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '1rem', color: 'var(--md-sys-color-on-surface-variant)', fontSize: '0.85rem' }}>
                       {gifSearch.trim().length < 2 ? 'Type to search...' : 'Searching...'}
                     </div>
                   )}
                 </div>
               </div>
            )}
          </div>
          <div
            ref={richInputRef}
            className="rich-input"
            contentEditable
            role="textbox"
            aria-multiline="true"
            data-placeholder={`Message ${currentSpace.is_dm === 1 ? '' : '#'}${getSpaceDisplayName()}...`}
            onInput={handleTyping}
            onKeyDown={handleKeyDown}
            onMouseUp={handleTextSelect}
            onKeyUp={handleTextSelect}
            onBlur={() => setTimeout(() => setFormatToolbar(null), 200)}
            onPaste={(e) => { e.preventDefault(); const text = e.clipboardData.getData('text/plain'); document.execCommand('insertText', false, text); const el = richInputRef.current; if (el) { processAllMarkdownInNode(el); setInput(serializeToMarkdown(el)); } }}
            suppressContentEditableWarning
          />
          {formatToolbar && (
            <div className="format-toolbar" style={{ position: 'fixed', top: formatToolbar.top, left: formatToolbar.left, transform: 'translateX(-50%)' }}>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); applyFormat('bold'); }} title="Bold"><strong>B</strong></button>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); applyFormat('italic'); }} title="Italic"><em>I</em></button>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); applyFormat('strikeThrough'); }} title="Strikethrough"><s>S</s></button>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); applyFormat('code'); }} title="Code" style={{ fontFamily: 'monospace' }}>&lt;/&gt;</button>
            </div>
          )}
          <button type="submit" className="send-fab" aria-label="Send">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M2.01 21L23 12L2.01 3L2 10L17 12L2 14L2.01 21Z" fill="currentColor" />
            </svg>
          </button>
        </form>
      </div>
      </>
        ) : (
           <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', color: 'var(--md-sys-color-outline)' }}>
             <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5, marginBottom: '16px' }}><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
             <p style={{ fontSize: '1.2rem', fontWeight: '500' }}>Select a space to start messaging</p>
           </div>
        )}
      </div>

      {/* Delete Space Confirm Modal */}
      {spaceToDelete && (
        <div style={{
          position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
          backgroundColor: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)',
          display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1100, padding: '1rem'
        }}>
          <div className="auth-card" style={{ maxWidth: '400px', margin: 0 }}>
            <h2 style={{ marginBottom: '1rem', color: theme === 'dark' ? '#ffb4ab' : '#ba1a1a', fontSize: '1.5rem', textAlign: 'center' }}>Delete Space?</h2>
            <p style={{ marginBottom: '2rem', color: 'var(--md-sys-color-on-surface-variant)', fontSize: '0.95rem', lineHeight: '1.4', textAlign: 'center' }}>
              Are you sure you want to permanently delete <strong>#{spaceToDelete.name}</strong>? All messages inside this space will be wiped forever.
            </p>
            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
              <button type="button" className="btn-secondary" onClick={() => setSpaceToDelete(null)}>Cancel</button>
              <button type="button" className="btn-primary" style={{ backgroundColor: theme === 'dark' ? '#ffb4ab' : '#ba1a1a', color: theme === 'dark' ? '#690005' : '#ffffff' }} onClick={() => deleteSpace(spaceToDelete.id)}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Message Confirm Modal */}
      {msgToDelete && (
        <div style={{
          position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
          backgroundColor: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)',
          display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1100, padding: '1rem'
        }}>
          <div className="auth-card" style={{ maxWidth: '400px', margin: 0 }}>
            <h2 style={{ marginBottom: '1rem', color: theme === 'dark' ? '#ffb4ab' : '#ba1a1a', fontSize: '1.5rem', textAlign: 'center' }}>Delete Message?</h2>
            <p style={{ marginBottom: '2rem', color: 'var(--md-sys-color-on-surface-variant)', fontSize: '0.95rem', lineHeight: '1.4', textAlign: 'center' }}>
              Are you sure you want to delete this message? This action cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
              <button type="button" className="btn-secondary" onClick={() => setMsgToDelete(null)}>Cancel</button>
              <button type="button" className="btn-primary" style={{ backgroundColor: theme === 'dark' ? '#ffb4ab' : '#ba1a1a', color: theme === 'dark' ? '#690005' : '#ffffff' }} onClick={() => deleteMessage(msgToDelete.id)}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <div style={{
          position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
          backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
          display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 100, padding: '1rem'
        }}>
          <style>{`.no-scrollbar::-webkit-scrollbar { display: none; } .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }`}</style>
          <div className="auth-card no-scrollbar" style={{ maxWidth: '500px', width: '100%', margin: 0, alignItems: 'stretch', maxHeight: '90vh', overflowY: 'auto', padding: '1.5rem', position: 'relative' }}>
            
            {/* Header Sticky */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <h1 style={{ margin: 0, fontSize: '1.4rem', color: 'var(--md-sys-color-on-surface)' }}>Settings</h1>
              <button type="button" onClick={() => setShowSettings(false)} style={{ background: 'var(--md-sys-color-surface-variant)', border: 'none', color: 'var(--md-sys-color-on-surface)', width: '32px', height: '32px', borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              </button>
            </div>

            {/* Top Row: Avatar & Theme Toggle */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', backgroundColor: 'var(--md-sys-color-surface-variant)', padding: '12px', borderRadius: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                {avatar ? (
                  <img src={avatar} style={{ width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover' }} alt="Profile" />
                ) : (
                  <div style={{ width: '40px', height: '40px', borderRadius: '50%', backgroundColor: 'var(--md-sys-color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--md-sys-color-on-primary)', fontSize: '1.2rem', fontWeight: 'bold' }}>
                    {profileData.first_name ? profileData.first_name.charAt(0).toUpperCase() : username.charAt(0).toUpperCase()}
                  </div>
                )}
                <label className="btn-secondary" style={{ cursor: 'pointer', padding: '0.4rem 0.75rem', fontSize: '0.75rem', background: 'var(--md-sys-color-surface)' }}>
                  Change Photo
                  <input type="file" accept="image/*" onChange={handleAvatarChange} style={{ display: 'none' }} />
                </label>
              </div>

              {/* Theme Toggle SVG */}
              <div style={{ display: 'flex', background: 'var(--md-sys-color-surface)', borderRadius: '24px', padding: '4px', border: '1px solid var(--md-sys-color-outline-variant)' }}>
                <button type="button" onClick={() => handleThemeChange('light')} style={{ padding: '6px', borderRadius: '50%', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', background: theme === 'light' ? 'var(--md-sys-color-primary-container)' : 'transparent', color: theme === 'light' ? 'var(--md-sys-color-on-primary-container)' : 'var(--md-sys-color-outline)', transition: 'all 0.2s' }} title="Light Mode">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>
                </button>
                <button type="button" onClick={() => handleThemeChange('dark')} style={{ padding: '6px', borderRadius: '50%', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', background: theme === 'dark' ? 'var(--md-sys-color-primary-container)' : 'transparent', color: theme === 'dark' ? 'var(--md-sys-color-on-primary-container)' : 'var(--md-sys-color-outline)', transition: 'all 0.2s' }} title="Dark Mode">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path></svg>
                </button>
              </div>
            </div>

            {/* Personal Details Compact Array */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '0.75rem' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label style={{ fontSize: '0.75rem', marginBottom: '4px' }}>First Name</label>
                <input type="text" value={profileData.first_name || ''} onChange={(e) => setProfileData({...profileData, first_name: e.target.value})} onBlur={() => saveProfileSettings()} placeholder="First" />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label style={{ fontSize: '0.75rem', marginBottom: '4px' }}>Last Name</label>
                <input type="text" value={profileData.last_name || ''} onChange={(e) => setProfileData({...profileData, last_name: e.target.value})} onBlur={() => saveProfileSettings()} placeholder="Last" />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '60% 1fr', gap: '0.75rem', marginBottom: '1.5rem', alignItems: 'center' }}>
              <div className="form-group" style={{ marginBottom: 0, position: 'relative', zIndex: showSuggestions ? 100 : 1 }}>
                <label style={{ fontSize: '0.75rem', marginBottom: '4px' }}>Location</label>
                <input type="text" value={profileData.location || ''} onChange={(e) => handleLocationChange(e.target.value)} onBlur={() => { setTimeout(() => setShowSuggestions(false), 200); saveProfileSettings(); }} onFocus={() => { if (profileData.location?.length >= 2) setShowSuggestions(true); }} placeholder="City, Zip" />
                {showSuggestions && locationSuggestions.length > 0 && (
                  <div className="location-suggestions" style={{ top: 'calc(100% + 4px)', padding: '4px' }}>
                    {locationSuggestions.map((s, idx) => (
                      <div key={idx} className="suggestion-item" style={{ padding: '6px 12px', fontSize: '0.85rem' }} onClick={() => { setProfileData({ ...profileData, location: s }); saveProfileSettings({ location: s }); setShowSuggestions(false); }}>{s}</div>
                    ))}
                  </div>
                )}
              </div>
              
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                <label style={{ fontSize: '0.75rem', marginBottom: '4px', fontWeight: 'bold', color: 'var(--md-sys-color-outline)' }}>Push Alerts</label>
                <button type="button" className={pushEnabled ? 'btn-primary' : 'btn-secondary'} onClick={togglePushNotifications} disabled={isSubscribing} style={{ padding: '0.4rem 0.75rem', fontSize: '0.75rem', height: '35px', width: '100%' }}>
                  {isSubscribing ? 'Wait...' : pushEnabled ? 'Enabled ✓' : 'Turn On'}
                </button>
              </div>
            </div>

            {/* Palette & Font Separated */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.5rem' }}>
              <div style={{ position: 'relative', zIndex: 90 }}>
                <label style={{ fontSize: '0.75rem', display: 'block', marginBottom: '6px', fontWeight: 600 }}>Typeface</label>
                <FontPicker value={profileData.font_family || globalFont || 'Inter'} onApply={(val) => { setProfileData({ ...profileData, font_family: val }); saveProfileSettings({ font_family: val }); }} />
              </div>
              <div>
                <label style={{ fontSize: '0.75rem', display: 'block', marginBottom: '6px', fontWeight: 600 }}>Accent Color</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input type="color" className="color-picker-input" value={colorPalette} onChange={(e) => handlePaletteChange(e.target.value)} />
                  <span style={{ fontSize: '0.8rem', fontFamily: 'monospace', opacity: 0.7 }}>{colorPalette.toUpperCase()}</span>
                </div>
              </div>
            </div>

            <div style={{ marginBottom: '1.5rem', backgroundColor: 'var(--md-sys-color-surface-variant)', padding: '12px', borderRadius: '12px' }}>
              <label style={{ fontSize: '0.75rem', display: 'flex', justifyContent: 'space-between', marginBottom: '8px', color: 'var(--md-sys-color-on-surface-variant)', fontWeight: 600 }}>
                <span>UI Scaling</span>
                <span style={{ color: 'var(--md-sys-color-primary)' }}>{Math.round(uiScale * 100)}%</span>
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', color: 'var(--md-sys-color-on-surface)' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 'bold' }}>A</span>
                <input 
                  type="range" 
                  min="0.8" 
                  max="1.5" 
                  step="0.05" 
                  value={uiScale} 
                  onChange={(e) => setUiScale(parseFloat(e.target.value))}
                  style={{ flex: 1, accentColor: 'var(--md-sys-color-primary)', cursor: 'pointer' }} 
                />
                <span style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>A</span>
              </div>
            </div>

            <div style={{ margin: '0 0 0.5rem' }}>
              <h3 style={{ fontSize: '0.9rem', marginBottom: '0.75rem', color: 'var(--md-sys-color-on-surface)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
                Change Password
              </h3>
              <div className="form-grid" style={{ gridTemplateColumns: '1fr', gap: '0.5rem' }}>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <div className="form-group" style={{ flex: 1, marginBottom: 0 }}><input type="password" placeholder="Current" value={pwChange.current} onChange={(e) => setPwChange(p => ({ ...p, current: e.target.value, msg: null }))} /></div>
                  <div className="form-group" style={{ flex: 1, marginBottom: 0 }}><input type="password" placeholder="New" value={pwChange.next} onChange={(e) => setPwChange(p => ({ ...p, next: e.target.value, msg: null }))} /></div>
                  <button type="button" className="btn-secondary" style={{ padding: '0.6rem 0.4rem', border: 'none', background: 'var(--md-sys-color-surface-variant)', flexShrink: 0, height: '100%', borderRadius: '8px' }} onClick={async () => {
                    if (!pwChange.current || !pwChange.next) return setPwChange(p => ({ ...p, msg: { ok: false, text: 'Required' } }));
                    const res = await fetch(`${socketUrl}/api/profile/password`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ currentPassword: pwChange.current, newPassword: pwChange.next }) });
                    const data = await res.json();
                    setPwChange(res.ok ? { current: '', next: '', confirm: '', msg: { ok: true, text: 'Updated!' } } : (p => ({ ...p, msg: { ok: false, text: data.error } })));
                    if (res.ok) setTimeout(() => setPwChange(p => ({ ...p, msg: null })), 3000);
                  }}>Save</button>
                </div>
                {pwChange.msg && (
                  <p style={{ margin: '0', fontSize: '0.75rem', textAlign: 'center', color: pwChange.msg.ok ? 'var(--md-sys-color-primary)' : 'var(--md-sys-color-error)' }}>{pwChange.msg.text}</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {croppingImage && (
        <AvatarCropper 
          image={croppingImage} 
          onComplete={onCropComplete} 
          onCancel={() => setCroppingImage(null)} 
        />
      )}

      {!appReady && (
        <div className={`loading-screen ${appReady ? 'fade-out' : ''}`}>
          <img src="/icon.png" alt="Logo" style={{ width: '120px', height: '120px', marginBottom: '2rem', borderRadius: '24px', boxShadow: '0 10px 30px rgba(0,0,0,0.3)' }} />
          <div className="loading-logo">Prado Chat</div>
          <div className="spinner"></div>
          <div style={{ marginTop: '1rem', color: 'var(--md-sys-color-outline)', fontSize: '0.9rem' }}>
            {isConnected ? 'Syncing your data...' : 'Connecting to server...'}
          </div>
        </div>
      )}

      {showAdminPanel && (
        <AdminPanel
          socket={socket}
          token={token}
          socketUrl={socketUrl}
          onClose={() => setShowAdminPanel(false)}
          globalFont={globalFont}
          currentUserId={profileData.id}
          onSelfUpdate={() => fetchProfile()}
          onPreviewAsset={(asset) => setSelectedAsset(
            asset.file.startsWith('http') ? asset.file :
            asset.file.startsWith('/uploads/') ? `${socketUrl}${asset.file}` :
            `${socketUrl}/uploads/${asset.file}`
          )}
        />
      )}

      {showVideoRoom && (
        <VideoRoom
          socket={socket}
          spaceId={currentSpace.id}
          onClose={() => setShowVideoRoom(false)}
        />
      )}

      {selectedAsset && (
        <div 
          style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', backgroundColor: 'rgba(0,0,0,0.9)', zIndex: 99999, display: 'flex', justifyContent: 'center', alignItems: 'center', cursor: 'auto' }}
          onClick={() => setSelectedAsset(null)}
        >
          {selectedAsset.match(/\.(mp4|mov|webm|mkv|3gp|avi|wmv|flv|m4v|mpg|mpeg)$/i) || selectedAsset.includes('transcoded-') ? (
            <video src={selectedAsset} controls autoPlay style={{ maxWidth: '95%', maxHeight: '95%', borderRadius: '8px', boxShadow: '0 10px 40px rgba(0,0,0,0.5)' }} onClick={(e) => e.stopPropagation()} />
          ) : selectedAsset.match(/\.(pdf|txt)$/i) ? (
            <iframe src={selectedAsset} style={{ width: '90%', height: '90%', border: 'none', borderRadius: '8px', backgroundColor: '#fff' }} onClick={(e) => e.stopPropagation()} />
          ) : selectedAsset.match(/\.(jpg|jpeg|png|gif|webp|heic|heif|bmp|svg|tiff|tif|ico)$/i) ? (
            <img src={selectedAsset} alt="Full Size" style={{ maxWidth: '95%', maxHeight: '95%', objectFit: 'contain', borderRadius: '8px', boxShadow: '0 10px 40px rgba(0,0,0,0.5)', cursor: 'zoom-out' }} onClick={(e) => { e.stopPropagation(); setSelectedAsset(null); }} />
          ) : (
            <div style={{ padding: '2.5rem', backgroundColor: 'var(--md-sys-color-surface)', borderRadius: '12px', textAlign: 'center', boxShadow: '0 20px 50px rgba(0,0,0,0.5)', border: '1px solid var(--md-sys-color-outline-variant)' }} onClick={(e) => e.stopPropagation()}>
               <div style={{ fontSize: '3.5rem', marginBottom: '1rem', color: 'var(--md-sys-color-on-surface-variant)' }}>📄</div>
               <h3 style={{ color: 'var(--md-sys-color-on-surface)', margin: '0 0 0.5rem', fontSize: '1.2rem' }}>Preview Not Available</h3>
               <p style={{ color: 'var(--md-sys-color-on-surface-variant)', fontSize: '0.9rem', marginBottom: '2rem', maxWidth: '300px' }}>This document type cannot be natively previewed in the browser. Please download it to view.</p>
               <a href={selectedAsset} target="_blank" rel="noopener noreferrer" download className="btn-primary" style={{ textDecoration: 'none', display: 'inline-block', padding: '0.75rem 1.5rem', borderRadius: '8px' }}>Download File</a>
            </div>
          )}
          <button onClick={() => setSelectedAsset(null)} style={{ position: 'absolute', top: '20px', right: '20px', background: 'rgba(255,255,255,0.2)', border: 'none', color: 'white', fontSize: '2rem', cursor: 'pointer', borderRadius: '50%', width: '50px', height: '50px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>&times;</button>
        </div>
      )}

      {showE2EEPrompt && (
        <div className="space-modal-overlay" onClick={(e) => { if (e.target.className === 'space-modal-overlay') setShowE2EEPrompt(null); }}>
          <div className="space-modal-content auth-card modal-compact" style={{ width: '90%', maxWidth: '400px', margin: 'auto' }}>
            <h2 style={{ marginTop: 0, color: 'var(--md-sys-color-on-surface)', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--md-sys-color-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
              Encrypted Space
            </h2>
            <p style={{ color: 'var(--md-sys-color-outline)', fontSize: '0.9rem', marginBottom: '1.5rem' }}>
              <strong>#{showE2EEPrompt.name}</strong> is End-to-End Encrypted. Enter the shared passkey to decrypt and read incoming messages.
            </p>
             <form onSubmit={async (e) => {
              e.preventDefault();
              setE2eeDecryptError(false);
              try {
                const derivedKey = await deriveKeyFromPassword(e2eePromptPasskey, showE2EEPrompt.e2ee_salt);
                setActiveKeys(prev => ({ ...prev, [showE2EEPrompt.id]: derivedKey }));
                setCurrentSpace(showE2EEPrompt);
                setShowSidebar(false);
                setMobileView('chat');
                setShowE2EEPrompt(null);
                setE2eePromptPasskey('');
              } catch(err) {
                console.error(err);
                setE2eeDecryptError(true);
              }
            }}>
              <div className="form-group" style={{ marginBottom: '1.5rem' }}>
                 <input type="password" placeholder="Passkey" className="text-input" style={{ width: '100%' }} value={e2eePromptPasskey} onChange={(e) => setE2eePromptPasskey(e.target.value)} required autoFocus />
                 {e2eeDecryptError && <p style={{ color: 'var(--md-sys-color-error)', fontSize: '0.85rem', marginTop: '0.5rem', fontWeight: 500 }}>Invalid derivation. Check the passkey.</p>}
              </div>
              <div style={{ display: 'flex', gap: '12px' }}>
                <button type="button" className="btn-secondary" onClick={() => { setShowE2EEPrompt(null); setE2eePromptPasskey(''); setE2eeDecryptError(false); }} style={{ flex: 1, padding: '0.75rem' }}>Cancel</button>
                <button type="submit" className="btn-primary" style={{ flex: 1, padding: '0.75rem' }}>Unlock Space</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showRoomSettingsModal && (
        <div className="space-modal-overlay" onClick={(e) => { if (e.target.className === 'space-modal-overlay') setShowRoomSettingsModal(false); }}>
          <div className="space-modal-content auth-card modal-compact" style={{ width: '90%', maxWidth: '450px', margin: 'auto', display: 'flex', flexDirection: 'column' }}>
            <h2 style={{ marginTop: 0, color: 'var(--md-sys-color-on-surface)', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--md-sys-color-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
              Room Settings
            </h2>
            <p style={{ color: 'var(--md-sys-color-outline)', fontSize: '0.9rem', marginBottom: '1.5rem' }}>Select members to directly invite to <strong>#{currentSpace.name}</strong>.</p>
            
            <form onSubmit={inviteToRoom} style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
              {allUsers.length > 0 ? (
                <div className="user-select-list" style={{ marginBottom: '1.5rem', flex: 1 }}>
                  <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--md-sys-color-on-surface)' }}>Workspace Users</label>
                  <div style={{ maxHeight: '250px', overflowY: 'auto', marginTop: '0.5rem', border: '1px solid var(--md-sys-color-outline-variant)', borderRadius: '8px', padding: '0.5rem', display: 'flex', flexDirection: 'column', gap: '4px', backgroundColor: 'var(--md-sys-color-background)' }}>
                    {allUsers.map(u => {
                      const isInvited = alreadyInvited.includes(u.id);
                      return (
                        <div key={u.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem 0.75rem', borderRadius: '4px', transition: 'background 0.2s', opacity: isInvited ? 0.6 : 1 }} className="user-invite-item">
                          <label style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: isInvited ? 'default' : 'pointer', flex: 1 }}>
                            <input 
                              type="checkbox" 
                              checked={isInvited || roomSettingsInvitedUsers.includes(u.id)}
                              disabled={isInvited}
                              onChange={(e) => {
                                if (isInvited) return;
                                if (e.target.checked) setRoomSettingsInvitedUsers(prev => [...prev, u.id]);
                                else setRoomSettingsInvitedUsers(prev => prev.filter(id => id !== u.id));
                              }}
                              style={{ width: '16px', height: '16px', cursor: isInvited ? 'default' : 'pointer' }}
                            />
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                              {u.avatar ? <img src={u.avatar} style={{ width: '24px', height: '24px', borderRadius: '50%', objectFit: 'cover' }} /> : <div style={{ width: '24px', height: '24px', borderRadius: '50%', backgroundColor: 'var(--md-sys-color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--md-sys-color-on-primary)', fontSize: '11px', fontWeight: 'bold' }}>{u.first_name ? u.first_name[0].toUpperCase() : u.username[0].toUpperCase()}</div>}
                              <span style={{ fontSize: '0.9rem', color: 'var(--md-sys-color-on-surface)', textDecoration: isInvited ? 'line-through' : 'none' }}>{u.first_name ? `${u.first_name} ${u.last_name || ''}`.trim() : u.username}</span>
                            </div>
                          </label>
                          {isInvited && (role === 'admin' || username === currentSpace.created_by) && (
                            <button type="button" onClick={() => removeUserFromSpace(u.id)} className="btn-secondary" style={{ padding: '4px 8px', fontSize: '0.75rem', color: 'var(--md-sys-color-error)', border: 'none', background: 'var(--md-sys-color-surface-variant)' }}>Remove</button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div className="spinner"></div>
                </div>
              )}

              <div style={{ display: 'flex', gap: '12px', marginTop: 'auto' }}>
                <button type="button" className="btn-secondary" onClick={() => setShowRoomSettingsModal(false)} style={{ flex: 1, padding: '0.75rem' }}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={isUpdatingRoom || roomSettingsInvitedUsers.length === 0} style={{ flex: 1, padding: '0.75rem' }}>
                  {isUpdatingRoom ? 'Inviting...' : 'Add Users'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showSpaceModal && (
        <div className="space-modal-overlay" onClick={(e) => { if (e.target.className === 'space-modal-overlay') setShowSpaceModal(false); }}>
          <div className="space-modal-content auth-card modal-compact" style={{ width: '90%', maxWidth: '450px', margin: 'auto', display: 'flex', flexDirection: 'column' }}>
            <h2 style={{ marginTop: 0, color: 'var(--md-sys-color-on-surface)', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--md-sys-color-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
              Create a Space
            </h2>
            <p style={{ color: 'var(--md-sys-color-outline)', fontSize: '0.9rem', marginBottom: '1.5rem' }}>Spaces are where your team communicates. They're best when organized around a topic.</p>
            
            <form onSubmit={async (e) => {
              e.preventDefault();
              setIsCreatingSpace(true);
              try {
                let exactUserId = profileData.id;
                try { exactUserId = exactUserId || JSON.parse(atob(token.split('.')[1])).userId; } catch(e){}

                const roomKey = await generateRoomKey();
                const keyShares = {};
                
                if (profileData && profileData.public_key && exactUserId) {
                   keyShares[exactUserId] = await encryptRoomKeyWithPublicKey(roomKey, profileData.public_key);
                }
                
                await Promise.all(invitedUsers.map(async (uId) => {
                   const uObj = allUsers.find(u => u.id === Number(uId));
                   if (uObj && uObj.public_key) {
                      keyShares[uId] = await encryptRoomKeyWithPublicKey(roomKey, uObj.public_key);
                   }
                }));

                const response = await fetch(`${socketUrl}/api/spaces`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                  },
                  body: JSON.stringify({ name: newSpaceName, is_private: isNewSpacePrivate, invited_users: invitedUsers, keyShares }),
                });
                const newSpace = await response.json();
                if (response.ok) {
                  setActiveKeys(prev => ({ ...prev, [newSpace.id]: roomKey }));
                  setSpaces(prev => { if (!prev.find(s => s.id === newSpace.id)) return [...prev, newSpace]; return prev; });
                  setCurrentSpace(newSpace);
                  setShowSpaceModal(false);
                  setNewSpaceName('');
                  setIsNewSpacePrivate(false);
                  setInvitedUsers([]);
                } else {
                  console.error('Failed to create space:', newSpace.error);
                }
              } catch (error) {
                console.error('Error creating space:', error);
              } finally {
                setIsCreatingSpace(false);
              }
            }}>
              <div className="form-group" style={{ marginBottom: '1.5rem' }}>
                <label>Name</label>
                <input type="text" className="text-input" style={{ width: '100%' }} placeholder="e.g. project-apollo" value={newSpaceName} onChange={(e) => setNewSpaceName(e.target.value)} required autoFocus disabled={isCreatingSpace} />
              </div>
              
              <div style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '1rem', backgroundColor: 'var(--md-sys-color-surface-variant)', borderRadius: '8px' }}>
                <label className="toggle-switch" style={{ position: 'relative', display: 'inline-block', width: '44px', height: '24px', flexShrink: 0 }}>
                  <input type="checkbox" id="private-toggle" checked={isNewSpacePrivate} onChange={(e) => { setIsNewSpacePrivate(e.target.checked); if (!e.target.checked) setInvitedUsers([]); }} disabled={isCreatingSpace} style={{ opacity: 0, width: 0, height: 0 }} />
                  <span className="toggle-slider" style={{ position: 'absolute', cursor: 'pointer', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: isNewSpacePrivate ? 'var(--md-sys-color-primary)' : 'var(--md-sys-color-outline-variant)', transition: '.4s', borderRadius: '24px' }}>
                    <span className="toggle-circle" style={{ position: 'absolute', content: '""', height: '16px', width: '16px', left: isNewSpacePrivate ? '24px' : '4px', bottom: '4px', backgroundColor: 'white', transition: '.4s', borderRadius: '50%' }}></span>
                  </span>
                </label>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <label htmlFor="private-toggle" style={{ cursor: 'pointer', fontWeight: 600, fontSize: '0.95rem', color: 'var(--md-sys-color-on-surface)' }}>Make Private</label>
                  <span style={{ fontSize: '0.85rem', color: 'var(--md-sys-color-outline)', marginTop: '4px' }}>
                    {isNewSpacePrivate ? 'Only invited members can view and join this space.' : 'Anyone in your workspace can view and join this space.'}
                  </span>
                </div>
              </div>


              {isNewSpacePrivate && allUsers.length > 0 && (
                <div className="user-select-list" style={{ marginBottom: '1.5rem' }}>
                  <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--md-sys-color-on-surface)' }}>Invite Members</label>
                  <div style={{ maxHeight: '180px', overflowY: 'auto', marginTop: '0.5rem', border: '1px solid var(--md-sys-color-outline-variant)', borderRadius: '8px', padding: '0.5rem', display: 'flex', flexDirection: 'column', gap: '4px', backgroundColor: 'var(--md-sys-color-background)' }}>
                    {allUsers.map(u => (
                      <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '0.5rem 0.75rem', cursor: 'pointer', borderRadius: '4px', transition: 'background 0.2s' }} className="user-invite-item">
                        <input 
                          type="checkbox" 
                          checked={invitedUsers.includes(u.id)}
                          onChange={(e) => {
                            if (e.target.checked) setInvitedUsers(prev => [...prev, u.id]);
                            else setInvitedUsers(prev => prev.filter(id => id !== u.id));
                          }}
                          style={{ width: '16px', height: '16px' }}
                        />
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          {u.avatar ? <img src={u.avatar} style={{ width: '24px', height: '24px', borderRadius: '50%', objectFit: 'cover' }} /> : <div style={{ width: '24px', height: '24px', borderRadius: '50%', backgroundColor: 'var(--md-sys-color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--md-sys-color-on-primary)', fontSize: '11px', fontWeight: 'bold' }}>{u.first_name ? u.first_name[0].toUpperCase() : u.username[0].toUpperCase()}</div>}
                          <span style={{ fontSize: '0.9rem', color: 'var(--md-sys-color-on-surface)' }}>{u.first_name ? `${u.first_name} ${u.last_name || ''}`.trim() : u.username}</span>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: '12px', marginTop: '2rem' }}>
                <button type="button" className="btn-secondary" onClick={() => setShowSpaceModal(false)} style={{ flex: 1, padding: '0.75rem' }}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={isCreatingSpace || !newSpaceName.trim()} style={{ flex: 1, padding: '0.75rem' }}>
                  {isCreatingSpace ? 'Creating...' : 'Create Room'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showDMModal && (
        <div className="space-modal-overlay" onClick={(e) => { if (e.target.className === 'space-modal-overlay') setShowDMModal(false); }}>
          <div className="space-modal-content auth-card modal-compact" style={{ width: '90%', maxWidth: '400px', margin: 'auto', display: 'flex', flexDirection: 'column' }}>
            <h2 style={{ marginTop: 0, color: 'var(--md-sys-color-on-surface)', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
              Direct Messages
            </h2>
            <p style={{ color: 'var(--md-sys-color-outline)', fontSize: '0.9rem', marginBottom: '1rem' }}>Select a team member to start a 1:1 conversation.</p>
            
            <div style={{ maxHeight: '260px', overflowY: 'auto', border: '1px solid var(--md-sys-color-outline-variant)', borderRadius: '8px', padding: '0.5rem', backgroundColor: 'var(--md-sys-color-background)', marginBottom: '1rem' }}>
              <div 
                className="user-invite-item" 
                style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '0.5rem 0.75rem', cursor: 'pointer', borderRadius: '4px', borderBottom: '1px solid var(--md-sys-color-surface-variant)' }}
                onClick={async () => {
                  setIsCreatingDM(true);
                  try {
                     const dmObj = { targetUserId: profileData.id || 0 }; // Sending own ID spawns 'self_' if handled right, actually backend uses req.user.userId anyway!
                     // Actually /api/dms uses req.body.targetUserId
                     // Just fetch /api/dms where target = their own ID
                     const res = await fetch(`${socketUrl}/api/dms`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ targetUserId: (spaces.find(s => s.name.startsWith('self_'))?.dm_username !== undefined ? 0 /* mock */ : 0) }) }); // We'll just map the target directly! Wait, profileData.id doesn't exist? Yes it does? Actually we can just find 'self_' in spaces!
                     const currentSelfDm = spaces.find(s => s.is_dm === 1 && s.name.startsWith('self_'));
                     if(currentSelfDm) { setCurrentSpace(currentSelfDm); setShowSidebar(false); setMobileView('chat'); }
                     setShowDMModal(false);
                  } finally { setIsCreatingDM(false); }
                }}
              >
                 <div style={{ width: '32px', height: '32px', borderRadius: '50%', backgroundColor: 'var(--md-sys-color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--md-sys-color-on-primary)', fontSize: '14px', fontWeight: 'bold' }}>{profileData.first_name ? profileData.first_name[0].toUpperCase() : username[0].toUpperCase()}</div>
                 <div style={{ display: 'flex', flexDirection: 'column' }}>
                   <span style={{ fontSize: '0.95rem', color: 'var(--md-sys-color-on-surface)', fontWeight: 600 }}>{profileData.first_name ? `${profileData.first_name} ${profileData.last_name || ''}`.trim() : username} (You)</span>
                   <span style={{ fontSize: '0.75rem', color: 'var(--md-sys-color-outline)' }}>Notes to Self space</span>
                 </div>
              </div>
              
              {allUsers.length > 0 ? allUsers.map(u => (
                <div 
                  key={u.id} 
                  className="user-invite-item" 
                  style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '0.5rem 0.75rem', cursor: 'pointer', borderRadius: '4px' }}
                  onClick={async () => {
                    setIsCreatingDM(true);
                    try {
                      let exactUserId = profileData.id;
                      try { exactUserId = exactUserId || JSON.parse(atob(token.split('.')[1])).userId; } catch(e){}

                      const roomKey = await generateRoomKey();
                      const keyShares = {};
                      if (profileData && profileData.public_key && exactUserId) {
                         keyShares[exactUserId] = await encryptRoomKeyWithPublicKey(roomKey, profileData.public_key);
                      }
                      if (u && u.public_key) {
                         keyShares[u.id] = await encryptRoomKeyWithPublicKey(roomKey, u.public_key);
                      }

                      const response = await fetch(`${socketUrl}/api/dms`, {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          'Authorization': `Bearer ${token}`,
                        },
                        body: JSON.stringify({ targetUserId: u.id, keyShares }),
                      });
                      const data = await response.json();
                      if (response.ok) {
                        setActiveKeys(prev => ({ ...prev, [data.spaceId]: roomKey }));
                        const targetSpace = spaces.find(s => s.id === data.spaceId);
                        if (targetSpace) {
                          setCurrentSpace(targetSpace);
                        } else {
                          // The space created socket event will pull it into the menu, but we can gracefully navigate by mutating instantly
                          const fetchRes = await fetch(`${socketUrl}/api/spaces`, { headers: { 'Authorization': `Bearer ${token}` } });
                          const allS = await fetchRes.json();
                          setSpaces(allS);
                          const ns = allS.find(s => s.id === data.spaceId);
                          if(ns) setCurrentSpace(ns);
                        }
                        setShowDMModal(false);
                        setShowSidebar(false);
                        setMobileView('chat');
                      } else {
                        console.error('Failed to create DM:', data.error);
                      }
                    } catch (error) {
                      console.error('Error creating DM:', error);
                    } finally {
                      setIsCreatingDM(false);
                    }
                  }}
                >
                  {u.avatar ? <img src={u.avatar} style={{ width: '32px', height: '32px', borderRadius: '50%', objectFit: 'cover' }} /> : <div style={{ width: '32px', height: '32px', borderRadius: '50%', backgroundColor: 'var(--md-sys-color-surface-variant)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--md-sys-color-on-surface-variant)', fontSize: '14px', fontWeight: 'bold' }}>{u.first_name ? u.first_name[0].toUpperCase() : u.username[0].toUpperCase()}</div>}
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                     <span style={{ fontSize: '0.95rem', color: 'var(--md-sys-color-on-surface)' }}>{u.first_name ? `${u.first_name} ${u.last_name || ''}`.trim() : u.username}</span>
                  </div>
                </div>
              )) : (
                 <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--md-sys-color-outline)' }}>No other users joined yet</div>
              )}
            </div>

            <div style={{ display: 'flex', gap: '12px' }}>
              <button type="button" className="btn-secondary" onClick={() => setShowDMModal(false)} style={{ width: '100%', padding: '0.75rem' }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {spaceToDelete && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 10000 }}>
          <div className="auth-card modal-compact" style={{ maxWidth: '400px', textAlign: 'center' }}>
            <h2 style={{ color: 'var(--md-sys-color-error)' }}>Delete Space?</h2>
            <p>Are you sure you want to delete <strong>{spaceToDelete.is_dm === 1 ? '' : '#'}{getSpaceDisplayName(spaceToDelete)}</strong>? All messages will be lost.</p>
            <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
              <button type="button" className="btn-secondary" onClick={() => setSpaceToDelete(null)} style={{ flex: 1 }}>Cancel</button>
              <button type="button" className="btn-primary" onClick={() => deleteSpace(spaceToDelete.id)} style={{ flex: 1, backgroundColor: 'var(--md-sys-color-error)', color: '#fff' }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {spaceToLeave && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 10000 }}>
          <div className="auth-card modal-compact" style={{ maxWidth: '400px', textAlign: 'center' }}>
            <h2>Leave Space?</h2>
            <p style={{ color: 'var(--md-sys-color-outline)', marginTop: '0.5rem' }}>Are you sure you want to securely exit <strong>{spaceToLeave.is_dm === 1 ? '' : '#'}{getSpaceDisplayName(spaceToLeave)}</strong>?</p>
            <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
              <button type="button" className="btn-secondary" onClick={() => setSpaceToLeave(null)} style={{ flex: 1 }}>Cancel</button>
              <button type="button" className="btn-primary" onClick={() => leaveSpace(spaceToLeave.id)} style={{ flex: 1 }}>Leave</button>
            </div>
          </div>
        </div>
      )}

    </div>
      )}
    </>
  );
}

export default App
