'use strict';

const SortedArray = require('collections/sorted-array');

const Gmoauth = require('./googlemusic_oauth');
const Splaylist = require('./splaylist');

require('./reporting');

// splaylists are cached locally to enable playlist linking.
// cache fields:
//   * splaylists: {id: splaylist}
// Cached splaylists contain additional fields:
//   * isAutoplaylist: bool
//   * orderedEntries: SortedArray({entryId, trackId, absolutePosition})

exports.open = function open() {
  // Return a new, empty cache.

  return {
    splaylists: {},
    _lastSyncMicros: null,
  };
};

exports.sync = function sync(cache, user, playlists, callback) {
  // Update a cache to reflect Google's state for this user.
  // Callback a set of deleted splaylist ids once the sync is done.
  console.log('syncing splaylist cache. current cache has:', Object.keys(cache.splaylists).length);

  const deletedIds = new Set();
  const autoPlaylistIds = new Set(playlists.map(p => p.remoteId));
  // TODO consider storing these separately to improve efficiency a bit.
  let maxPTimestamp = null;
  let maxETimestamp = null;

  Gmoauth.getPlaylistChanges(user, cache._lastSyncMicros, mutations => {
    for (let i = 0; i < mutations.length; i++) {
      const mutation = mutations[i];

      const lmTimestamp = parseInt(mutation.lastModifiedTimestamp, 10);
      if (lmTimestamp) {
        maxPTimestamp = Math.max(maxPTimestamp || lmTimestamp, lmTimestamp);
      }

      if (mutation.deleted) {
        delete cache.splaylists[mutation.id];  // eslint-disable-line no-param-reassign
        deletedIds.add(mutation.id);
      } else if (!(mutation.id in cache.splaylists)) {
        const splaylist = Splaylist.fromSJ(mutation);
        splaylist.isAutoplaylist = autoPlaylistIds.has(mutation.id);
        splaylist.orderedEntries = createEntryArray();
        splaylist._entries = {};
        cache.splaylists[mutation.id] = splaylist;  // eslint-disable-line no-param-reassign
      } else {
        const oldSplaylist = cache.splaylists[mutation.id];
        const newSplaylist = Splaylist.fromSJ(mutation);
        newSplaylist.isAutoplaylist = autoPlaylistIds.has(mutation.id);
        newSplaylist.orderedEntries = oldSplaylist.orderedEntries;
        newSplaylist._entries = oldSplaylist._entries;
        cache.splaylists[mutation.id] = newSplaylist;  // eslint-disable-line no-param-reassign
      }
    }

    Gmoauth.getEntryChanges(user, cache._lastSyncMicros, entryMutations => {
      for (let i = 0; i < entryMutations.length; i++) {
        const mutation = entryMutations[i];

        const lmTimestamp = parseInt(mutation.lastModifiedTimestamp, 10);
        if (lmTimestamp) {
          maxETimestamp = Math.max(maxETimestamp || lmTimestamp, lmTimestamp);
        }

        // This assumes that entries can't change playlists without a delete.
        const splaylist = cache.splaylists[mutation.playlistId];

        if (!splaylist) {
          // These orphaned entries usually belong to a playlist that was recently deleted.
          // It can also happen if a playlist is added between the playlist and entries calls,
          // in which case it's more of a problem (and one that's not dealt with).
          continue;
        }

        const oldEntry = splaylist._entries[mutation.id];
        const entry = entryFromMutation(mutation);

        // SortedArray noops duplicate adds, so we need to delete if we're already tracking the entry.
        if (oldEntry) {
          splaylist.orderedEntries.delete(oldEntry);
        }

        if (mutation.deleted) {
          delete splaylist._entries[entry.entryId];
        } else {
          splaylist._entries[entry.entryId] = entry;
          splaylist.orderedEntries.add(entry);
        }
      }

      if (maxPTimestamp && maxETimestamp) {
        // They're both numbers; take the smaller.
        cache._lastSyncMicros = Math.min(maxPTimestamp, maxETimestamp); // eslint-disable-line no-param-reassign
      } else {
        // One or both is null.
        cache._lastSyncMicros = maxPTimestamp || maxETimestamp; // eslint-disable-line no-param-reassign
      }

      const cacheInfo = {lastSync: cache._lastSyncMicros};
      let inconsistent = false;
      for (const id in cache.splaylists) {
        const splaylist = cache.splaylists[id];
        const orderedLen = splaylist.orderedEntries.length;
        const unorderedLen = Object.keys(splaylist._entries).length;
        cacheInfo[`${splaylist.title} (${id})`] = `${unorderedLen}, ${orderedLen}`;
        inconsistent = inconsistent || (orderedLen !== unorderedLen);
      }
      const cacheInfoStr = JSON.stringify(cacheInfo, null, '  ');
      if (inconsistent) {
        console.warn('cache synced inconsistently to', cacheInfoStr, cache);
      } else {
        console.debug('cache synced to', cacheInfoStr, cache);
      }

      callback(deletedIds);
    });
  });
};

function entryFromMutation(mutation) {
  return {
    entryId: mutation.id,
    absolutePosition: parseInt(mutation.absolutePosition, 10),
    trackId: mutation.trackId,
  };
}

function entryEquals(one, two) {
  return one.entryId === two.entryId;
}

function entryCompare(left, right) {
  if (left.absolutePosition < right.absolutePosition) {
    return -1;
  }
  if (left.absolutePosition > right.absolutePosition) {
    return 1;
  }
  return 0;
}


function createEntryArray() {
  return new SortedArray([], entryEquals, entryCompare);
}
