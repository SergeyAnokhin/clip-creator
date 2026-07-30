import { useState } from 'react';
import {
  cloneBlockWithType, deleteLine, duplicateLine, insertBlockAdjacent, moveBlock, moveBlockToEdge, moveToEdgeForType,
  repeatChorusAfterVerses, setLine, splitBlockAtLine, splitBlockEveryN, toggleLineBrackets,
} from '../lib/lyrics.js';

function randomId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Lyrics stage: which block/line is being edited, which popover is open, and
 * every block/line mutation. The mutations themselves are pure functions in
 * lib/lyrics.js - this hook only wires them to state and persistence. */
export function useLyricsStage({ updateProject, showToast, L }) {
  const [editingBlockId, setEditingBlockId] = useState(null);
  const [draftContent, setDraftContent] = useState('');
  const [editingLineBlockId, setEditingLineBlockId] = useState(null);
  const [editingLineIndex, setEditingLineIndex] = useState(null);
  const [lineDraft, setLineDraft] = useState('');
  const [openMenuTypeBlockId, setOpenMenuTypeBlockId] = useState(null);
  const [openMenuCloneBlockId, setOpenMenuCloneBlockId] = useState(null);
  const [openTagMenuBlockId, setOpenTagMenuBlockId] = useState(null);
  const [splitGroupSize, setSplitGroupSize] = useState(4);

  function addBlock() {
    updateProject((p) => ({
      ...p,
      blocks: [...p.blocks, { id: randomId('blk'), type: 'verse', importance: 3, content: 'Новый блок текста...' }],
    }));
  }
  function moveBlockAction(id, dir) {
    updateProject((p) => ({ ...p, blocks: moveBlock(p.blocks, id, dir) }));
  }
  function moveBlockToEdgeAction(id, edge) {
    updateProject((p) => ({ ...p, blocks: moveBlockToEdge(p.blocks, id, edge) }));
  }
  function splitBlock(id, lineIndex) {
    updateProject((p) => ({ ...p, blocks: splitBlockAtLine(p.blocks, id, lineIndex, randomId('blk')) }));
  }
  function splitIntoGroups(id, n) {
    updateProject((p) => ({ ...p, blocks: splitBlockEveryN(p.blocks, id, n, () => randomId('blk')) }));
  }
  function toggleTypeMenu(id) {
    setOpenMenuTypeBlockId((cur) => (cur === id ? null : id));
    setOpenMenuCloneBlockId(null);
  }
  function toggleCloneMenu(id) {
    setOpenMenuCloneBlockId((cur) => (cur === id ? null : id));
    setOpenMenuTypeBlockId(null);
  }
  function setBlockType(id, type) {
    updateProject((p) => ({
      ...p,
      blocks: moveToEdgeForType(p.blocks.map((b) => (b.id === id ? { ...b, type } : b)), id, type),
    }));
    setOpenMenuTypeBlockId(null);
  }
  function cloneBlockAsType(id, type) {
    updateProject((p) => ({ ...p, blocks: cloneBlockWithType(p.blocks, id, type, randomId('blk')) }));
    setOpenMenuCloneBlockId(null);
    showToast(L.toast_duplicated);
  }
  function toggleLineBracket(blockId, lineIndex) {
    updateProject((p) => ({
      ...p,
      blocks: p.blocks.map((b) => (b.id === blockId ? { ...b, content: toggleLineBrackets(b.content, lineIndex) } : b)),
    }));
  }
  function toggleTagMenu(id) { setOpenTagMenuBlockId((cur) => (cur === id ? null : id)); }
  function insertTagBlock(afterId, tagText, position) {
    updateProject((p) => ({
      ...p,
      blocks: insertBlockAdjacent(p.blocks, afterId, 'interlude', tagText, position, randomId('blk')),
    }));
    setOpenTagMenuBlockId(null);
  }
  function startEditBlock(id, content) { setEditingBlockId(id); setDraftContent(content); }
  function saveEditBlock() {
    updateProject((p) => ({ ...p, blocks: p.blocks.map((b) => (b.id === editingBlockId ? { ...b, content: draftContent } : b)) }));
    setEditingBlockId(null);
  }
  function cancelEditBlock() { setEditingBlockId(null); }
  function startEditLine(blockId, lineIndex, content) {
    setEditingLineBlockId(blockId);
    setEditingLineIndex(lineIndex);
    setLineDraft(content);
  }
  function saveEditLine() {
    updateProject((p) => ({
      ...p,
      blocks: p.blocks.map((b) => (
        b.id === editingLineBlockId ? { ...b, content: setLine(b.content, editingLineIndex, lineDraft) } : b
      )),
    }));
    setEditingLineBlockId(null);
    setEditingLineIndex(null);
  }
  function cancelEditLine() { setEditingLineBlockId(null); setEditingLineIndex(null); }
  function duplicateLineAction(blockId, lineIndex) {
    updateProject((p) => ({
      ...p,
      blocks: p.blocks.map((b) => (b.id === blockId ? { ...b, content: duplicateLine(b.content, lineIndex) } : b)),
    }));
  }
  function deleteLineAction(blockId, lineIndex) {
    updateProject((p) => ({
      ...p,
      blocks: p.blocks.map((b) => (b.id === blockId ? { ...b, content: deleteLine(b.content, lineIndex) } : b)),
    }));
  }
  function duplicateBlock(id) {
    updateProject((p) => {
      const idx = p.blocks.findIndex((b) => b.id === id);
      const copy = { ...p.blocks[idx], id: randomId('blk') };
      return { ...p, blocks: [...p.blocks.slice(0, idx + 1), copy, ...p.blocks.slice(idx + 1)] };
    });
    showToast(L.toast_duplicated);
  }
  function deleteBlock(id) {
    updateProject((p) => ({ ...p, blocks: p.blocks.filter((b) => b.id !== id) }));
    showToast(L.toast_deleted);
  }
  function repeatChorus() {
    updateProject((p) => ({ ...p, blocks: repeatChorusAfterVerses(p.blocks, () => randomId('blk')) }));
    showToast(L.toast_chorusRepeated);
  }

  return {
    state: {
      editingBlockId, draftContent, openMenuTypeBlockId, openMenuCloneBlockId, openTagMenuBlockId, splitGroupSize,
      editingLineBlockId, editingLineIndex, lineDraft,
    },
    actions: {
      addBlock, moveBlock: moveBlockAction, moveBlockToEdge: moveBlockToEdgeAction, splitBlock, splitIntoGroups, setSplitGroupSize,
      toggleTypeMenu, setBlockType, toggleCloneMenu, cloneBlockAsType, toggleLineBracket, repeatChorus,
      toggleTagMenu, insertTagBlock,
      duplicateBlock, deleteBlock,
      startEditBlock, saveEditBlock, cancelEditBlock, setDraftContent,
      startEditLine, saveEditLine, cancelEditLine, setLineDraft, duplicateLine: duplicateLineAction,
      deleteLine: deleteLineAction,
    },
  };
}
