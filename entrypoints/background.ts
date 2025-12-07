
import { defineBackground } from 'wxt/sandbox';
import { browser } from 'wxt/browser';
import { callTencentTranslation } from '../utils/api';
import { dictionariesStorage } from '../utils/storage';
import { DictionaryEngine } from '../types';

interface DictData {
    phoneticUs: string;
    phoneticUk: string;
    definitions: { part: string; means: string[] }[];
    sentences: { orig: string; trans: string }[];
    inflections: string[];
}

export default defineBackground(() => {
  // Check if we need to seed data on install
  browser.runtime.onInstalled.addListener(() => {
    console.log('ContextLingo Extension Installed');
  });

  // Handle Extension Icon Click -> Open Dashboard (Options Page) in a NEW TAB
  browser.action.onClicked.addListener(() => {
    // Use browser.runtime.getURL to safely get the path to options.html
    const url = (browser.runtime as any).getURL('/options.html');
    browser.tabs.create({ url });
  });

  // Handle Shortcuts
  browser.commands.onCommand.addListener((command) => {
    if (command === 'translate-page') {
      // Send message to active tab to trigger translation
      browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
        if (tabs[0]?.id) {
          browser.tabs.sendMessage(tabs[0].id, { action: 'TRIGGER_TRANSLATION' });
        }
      });
    }
  });

  // --- Helper: Fetch Dictionary Data with Failover ---
  const fetchEnglishDictionaryData = async (word: string): Promise<DictData | null> => {
      const allDicts = await dictionariesStorage.getValue();
      const enabledDicts = allDicts.filter(d => d.isEnabled).sort((a, b) => a.priority - b.priority);

      for (const dict of enabledDicts) {
          try {
              // --- 1. ICBA (Kingsoft) - High Priority China Source ---
              if (dict.id === 'iciba') {
                  const key = "D2AE3342306915865405466432026857"; // Open public key for ICBA API
                  const res = await fetch(`https://dict-co.iciba.com/api/dictionary.php?w=${word}&type=json&key=${key}`);
                  if (!res.ok) continue;
                  
                  const data = await res.json();
                  // Check valid response
                  if (!data || !data.symbols || data.symbols.length === 0) continue;

                  const symbol = data.symbols[0];
                  
                  // Extract definitions with Part of Speech
                  const definitions = (symbol.parts || []).map((p: any) => ({
                      part: p.part ? (p.part.endsWith('.') ? p.part : p.part + '.') : '', // Normalize POS
                      means: p.means || [] // Array of strings
                  }));

                  // Extract sentences and FILTER out bad ones (short or single word)
                  const sentences = (data.sent || []).map((s: any) => ({
                      orig: s.orig ? s.orig.trim() : "",
                      trans: s.trans ? s.trans.trim() : ""
                  })).filter((s: any) => s.orig.length > 8 && s.orig.includes(' ') && s.trans); 

                  // Extract Inflections (Exchange)
                  let inflections: string[] = [];
                  if (data.exchange) {
                      // exchange is often { word_pl: [...], word_past: [...], ... }
                      // Values can be arrays of strings or strings
                      Object.values(data.exchange).forEach((val: any) => {
                          if (Array.isArray(val)) {
                              inflections.push(...val);
                          } else if (typeof val === 'string' && val.trim()) {
                              inflections.push(val);
                          }
                      });
                  }
                  inflections = [...new Set(inflections)]; // Dedupe

                  return {
                      phoneticUs: symbol.ph_am ? `/${symbol.ph_am}/` : '',
                      phoneticUk: symbol.ph_en ? `/${symbol.ph_en}/` : '',
                      definitions,
                      sentences,
                      inflections
                  };
              }

              // --- 2. Youdao (NetEase) - China Source ---
              if (dict.id === 'youdao') {
                  // Using jsonapi which is richer
                  const res = await fetch(`https://dict.youdao.com/jsonapi?q=${word}`);
                  if (!res.ok) continue;

                  const data = await res.json();
                  
                  let phoneticUs = "";
                  let phoneticUk = "";
                  
                  // Phonetics from simple or ec
                  if (data.simple && data.simple.word && data.simple.word.length > 0) {
                      const w = data.simple.word[0];
                      if(w['usphone']) phoneticUs = `/${w['usphone']}/`;
                      if(w['ukphone']) phoneticUk = `/${w['ukphone']}/`;
                  }
                  if (!phoneticUs && data.ec && data.ec.word && data.ec.word.length > 0) {
                      const w = data.ec.word[0];
                      if(w['usphone']) phoneticUs = `/${w['usphone']}/`;
                      if(w['ukphone']) phoneticUk = `/${w['ukphone']}/`;
                  }

                  // Definitions
                  const definitions: { part: string; means: string[] }[] = [];
                  
                  // Try extracting from 'ec' (most common)
                  if (data.ec && data.ec.word && data.ec.word.length > 0 && data.ec.word[0].trs) {
                      data.ec.word[0].trs.forEach((trItem: any) => {
                          // Try to find pos and tran
                          // Youdao struct can be simple object or nested
                          // Commonly: { pos: "n.", tran: "书籍" }
                          if (trItem.pos || trItem.tran) {
                              let pos = trItem.pos || '';
                              if (pos && !pos.endsWith('.')) pos += '.';
                              
                              definitions.push({
                                  part: pos,
                                  means: [trItem.tran || '']
                              });
                          } else if (trItem.tr && trItem.tr[0] && trItem.tr[0].l && trItem.tr[0].l.i) {
                               // Fallback deeper nested structure sometimes seen
                               const raw = trItem.tr[0].l.i[0];
                               // Raw might be "n. 书籍" or just "书籍"
                               // Simple parsing
                               const parts = raw.match(/^([a-z]+\.)\s*(.*)/);
                               if (parts) {
                                   definitions.push({
                                       part: parts[1],
                                       means: [parts[2]]
                                   });
                               } else {
                                   definitions.push({ part: '', means: [raw] });
                               }
                          }
                      });
                  }

                  // Sentences
                  let sentences: { orig: string; trans: string }[] = [];
                  if (data.blng_sents_part && data.blng_sents_part['sentence-pair']) {
                      sentences = data.blng_sents_part['sentence-pair'].map((pair: any) => ({
                          orig: pair.sentence || "",
                          trans: pair['sentence-translation'] || ""
                      }));
                  }
                  
                  // Filter Youdao sentences too
                  sentences = sentences.filter(s => s.orig.length > 8 && s.orig.includes(' ') && s.trans);

                  // Extract Inflections
                  const inflections: string[] = [];
                  if (data.simple?.word?.[0]?.exchange) {
                      const ex = data.simple.word[0].exchange;
                      Object.values(ex).forEach((val: any) => {
                           if (Array.isArray(val)) inflections.push(...val);
                           else if (typeof val === 'string' && val.trim()) inflections.push(val);
                      });
                  }
                  
                  return {
                      phoneticUs,
                      phoneticUk,
                      definitions,
                      sentences,
                      inflections: [...new Set(inflections)]
                  };
              }

              // --- 3. Free Dictionary API (Google) ---
              if (dict.id === 'free-dict') {
                  const res = await fetch(`${dict.endpoint}${word}`);
                  if (!res.ok) continue; 
                  const data = await res.json();
                  if (!Array.isArray(data) || data.length === 0) continue;
                  
                  const entry = data[0];
                  const usPhonetic = entry.phonetics?.find((p: any) => p.audio?.includes('-us.mp3') || p.text)?.text || entry.phonetic || '';
                  const ukPhonetic = entry.phonetics?.find((p: any) => p.audio?.includes('-uk.mp3'))?.text || '';

                  const definitions: { part: string; means: string[] }[] = [];
                  if (entry.meanings) {
                      entry.meanings.forEach((m: any) => {
                          const means = m.definitions.map((d: any) => d.definition);
                          definitions.push({
                              part: m.partOfSpeech || '',
                              means: means
                          });
                      });
                  }
                  
                  const example = entry.meanings?.[0]?.definitions?.find((d: any) => d.example)?.example || '';
                  const sentences = example ? [{ orig: example, trans: '' }] : [];
                  const inflections: string[] = []; 

                  return {
                      phoneticUs: usPhonetic,
                      phoneticUk: ukPhonetic,
                      definitions,
                      sentences,
                      inflections
                  };
              } 
              
              // --- 4. Wiktionary (Fallback) ---
              if (dict.id === 'wiktionary') {
                   // Fallback to Wiktionary (Skipped for brevity, complex parsing)
                   continue; 
              }
          } catch (e) {
              console.warn(`Dictionary ${dict.name} failed for ${word}`, e);
          }
      }
      return null;
  };

  // Improved Sentence Assigner: Tries to find a sentence that matches the definition keywords
  const smartAssignSentence = (
      sentences: { orig: string; trans: string }[], 
      definitionKeywords: string[],
      usedIndices: Set<number>
  ) => {
      if (!sentences || sentences.length === 0) return { orig: '', trans: '' };
      
      // 1. Try to find a sentence that contains one of the definition keywords in its translation
      for (let i = 0; i < sentences.length; i++) {
          if (usedIndices.has(i)) continue; // Skip used sentences
          
          const sent = sentences[i];
          if (!sent.trans) continue;

          for (const keyword of definitionKeywords) {
              // Exact keyword match (e.g. "预订" in "我预订了机票")
              // We do NOT use fuzzy single-char matching anymore to avoid false positives (e.g. "书" matching "书写" or "证书")
              if (keyword.length > 0 && sent.trans.includes(keyword)) {
                  usedIndices.add(i);
                  return sent;
              }
          }
      }

      // 2. Strict Fallback
      // ONLY if this is the very first definition (usedIndices is empty), and we found no match,
      // we return the first sentence as a generic example.
      // If usedIndices is NOT empty (meaning previous definitions already took some sentences),
      // we DO NOT return a fallback. This prevents "Book" sentences appearing for "Reserve".
      if (usedIndices.size === 0 && sentences.length > 0) {
           usedIndices.add(0);
           return sentences[0];
      }

      // Return empty to indicate no suitable match
      return { orig: '', trans: '' };
  };

  // Helper to extract keywords from meaning array
  const extractKeywords = (means: string[]) => {
      // Split by common separators, remove POS prefixes (e.g. "n. "), remove brackets
      return means.flatMap(m => m.split(/[,，;；]/))
          .map(s => s.replace(/^[a-z]+\.\s*/, '')) // Remove start "n. "
          .map(s => s.replace(/[（(].*?[)）]/g, '')) // Remove (brackets)
          .map(s => s.replace(/[\[【].*?[\]】]/g, '')) // Remove [brackets]
          .map(s => s.trim())
          .filter(s => s.length > 0);
  };

  // Message Handler for API Requests
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'TRANSLATE_TEXT') {
      (async () => {
        try {
          // Translate logic
          if (message.engine.id === 'tencent') {
             const result = await callTencentTranslation(message.engine, message.text, message.target);
             sendResponse({ success: true, data: result });
          } else if (message.engine.id === 'custom-mock') {
             sendResponse({ success: true, data: { Response: { TargetText: `Simulated translation for: ${message.text}` } } });
          } else {
             throw new Error(`Engine ${message.engine.name} not supported in background proxy yet.`);
          }
        } catch (error: any) {
          console.error('ContextLingo Background Error:', error);
          sendResponse({ success: false, error: error.message || String(error) });
        }
      })();
      return true; 
    }

    if (message.action === 'LOOKUP_WORD') {
      (async () => {
        try {
          console.log('ContextLingo Background: Looking up word...', message.text);
          const { engine, text, preferredTranslation } = message;

          if (engine.id === 'custom-mock') {
              // Simulate Rich Data for testing
              const mockResult = {
                text: text,
                phoneticUs: `/${text}US/`,
                phoneticUk: `/${text}UK/`,
                inflections: [`${text}ing`, `${text}ed`, `${text}s`],
                meanings: [
                    {
                        translation: preferredTranslation || "n. 示例释义1",
                        contextSentence: `This is a sentence for ${text} meaning 1.`,
                        contextSentenceTranslation: `这是关于 ${text} 含义1的句子。`,
                        mixedSentence: `这是一个关于 ${text} (示例释义1) 的句子。`,
                        dictionaryExample: `Example usage of ${text}.`,
                        dictionaryExampleTranslation: `关于 ${text} 的例句用法。`
                    }
                ]
              };
              await new Promise(r => setTimeout(r, 600));
              sendResponse({ success: true, data: mockResult });
              return;
          }

          // 1. Fetch Real Dictionary Data First
          const dictData = await fetchEnglishDictionaryData(text);

          // 2. Prepare Meanings
          let meanings: { 
              translation: string; 
              partOfSpeech?: string;
              contextSentence: string; 
              mixedSentence: string; 
              dictionaryExample: string;
              dictionaryExampleTranslation: string;
          }[] = [];

          if (dictData && dictData.definitions.length > 0) {
              const validSentences = dictData.sentences;
              const usedIndices = new Set<number>();

              meanings = dictData.definitions.map((def, idx) => {
                  const formattedTranslation = def.part ? `${def.part} ${def.means.join('; ')}` : def.means.join('; ');
                  
                  // Use Smart Assignment Logic
                  const keywords = extractKeywords(def.means);
                  const sent = smartAssignSentence(validSentences, keywords, usedIndices);

                  return {
                      translation: formattedTranslation.trim(),
                      partOfSpeech: def.part,
                      contextSentence: '',
                      mixedSentence: '',
                      dictionaryExample: sent.orig,
                      dictionaryExampleTranslation: sent.trans
                  };
              });
          } else if (engine.id === 'tencent') {
              const res = await callTencentTranslation(engine, text, 'zh');
              const trans = res.Response?.TargetText || "API Error";
              meanings.push({
                  translation: trans,
                  contextSentence: '',
                  mixedSentence: '',
                  dictionaryExample: '',
                  dictionaryExampleTranslation: ''
              });
          }

          const result = {
              text: text,
              phoneticUs: dictData?.phoneticUs || '',
              phoneticUk: dictData?.phoneticUk || '',
              inflections: dictData?.inflections || [],
              meanings: meanings
          };
          sendResponse({ success: true, data: result });

        } catch (error: any) {
          console.error('ContextLingo Background Error:', error);
          sendResponse({ success: false, error: error.message || String(error) });
        }
      })();
      return true;
    }
  });
});
