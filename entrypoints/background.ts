
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
                  
                  const definitions = (symbol.parts || []).map((p: any) => ({
                      part: p.part || '',
                      means: p.means || [] // Array of strings
                  }));

                  const sentences = (data.sent || []).map((s: any) => ({
                      orig: s.orig ? s.orig.trim() : "",
                      trans: s.trans ? s.trans.trim() : ""
                  }));

                  return {
                      phoneticUs: symbol.ph_am ? `/${symbol.ph_am}/` : '',
                      phoneticUk: symbol.ph_en ? `/${symbol.ph_en}/` : '',
                      definitions,
                      sentences
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
                          if (trItem.pos && trItem.tran) {
                              definitions.push({
                                  part: trItem.pos,
                                  means: [trItem.tran]
                              });
                          } else if (trItem.tr && trItem.tr[0] && trItem.tr[0].l && trItem.tr[0].l.i) {
                               // Fallback deeper nested structure sometimes seen
                               const raw = trItem.tr[0].l.i[0];
                               // Raw might be "n. 书籍"
                               // Simple parsing
                               const parts = raw.split('.');
                               if (parts.length > 1) {
                                   definitions.push({
                                       part: parts[0] + '.',
                                       means: [parts.slice(1).join('.').trim()]
                                   });
                               } else {
                                   definitions.push({ part: '', means: [raw] });
                               }
                          }
                      });
                  }

                  // Sentences
                  const sentences: { orig: string; trans: string }[] = [];
                  if (data.blng_sents_part && data.blng_sents_part['sentence-pair']) {
                      data.blng_sents_part['sentence-pair'].forEach((pair: any) => {
                          if (pair.sentence && pair['sentence-translation']) {
                              sentences.push({
                                  orig: pair.sentence,
                                  trans: pair['sentence-translation']
                              });
                          }
                      });
                  }

                  if (phoneticUs || phoneticUk || definitions.length > 0) {
                      return { phoneticUs, phoneticUk, definitions, sentences };
                  }
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

                  return {
                      phoneticUs: usPhonetic,
                      phoneticUk: ukPhonetic,
                      definitions,
                      sentences
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
                meanings: [
                    {
                        translation: preferredTranslation || "示例释义1",
                        contextSentence: `This is a sentence for ${text} meaning 1.`,
                        contextSentenceTranslation: `这是关于 ${text} 含义1的句子。`,
                        mixedSentence: `这是一个关于 ${text} (示例释义1) 的句子。`,
                        dictionaryExample: `Example usage of ${text}.`,
                        dictionaryExampleTranslation: `关于 ${text} 的例句用法。`
                    },
                    // Add a second meaning for testing multiselect
                    {
                        translation: "示例释义2 (Mock)",
                        contextSentence: `Another context for ${text}.`,
                        mixedSentence: `另一个 ${text} (示例释义2) 的句子。`,
                        dictionaryExample: `Second example of ${text}.`,
                        dictionaryExampleTranslation: `关于 ${text} 的第二个例句。`
                    }
                ]
              };
              await new Promise(r => setTimeout(r, 600));
              sendResponse({ success: true, data: mockResult });
              return;
          }

          if (engine.id === 'tencent') {
             // 1. Fetch Real Dictionary Data First
             const dictData = await fetchEnglishDictionaryData(text);

             // 2. Prepare Meanings
             let meanings = [];

             if (dictData && dictData.definitions.length > 0) {
                 // Use dictionary definitions
                 // We attach the first example to all definitions for now, 
                 // as we can't easily map sentences to specific definitions without NLP.
                 const firstSent = dictData.sentences[0] || { orig: '', trans: '' };
                 
                 meanings = dictData.definitions.map(def => ({
                     translation: `${def.part} ${def.means.join('; ')}`.trim(),
                     partOfSpeech: def.part,
                     contextSentence: '',
                     mixedSentence: '',
                     dictionaryExample: firstSent.orig,
                     dictionaryExampleTranslation: firstSent.trans
                 }));
             } else {
                 // Fallback: Translate using Tencent if no dict data
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
                 meanings: meanings
             };
             sendResponse({ success: true, data: result });

          } else {
             // AI Engines (Placeholder)
             throw new Error(`Engine ${engine.name} does not support dictionary lookup yet.`);
          }

        } catch (error: any) {
          console.error('ContextLingo Background Error:', error);
          sendResponse({ success: false, error: error.message || String(error) });
        }
      })();
      return true;
    }
  });
});
