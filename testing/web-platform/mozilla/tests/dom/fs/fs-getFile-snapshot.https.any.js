// META: title=FileSystemFileHandle.getFile() snapshots become unreadable when the file changes
// META: global=window,dedicatedworker
// META: script=/fs/resources/test-helpers.js
// META: script=/fs/resources/sandboxed-fs-test-helpers.js

// A File returned by getFile() reads the file in place and its snapshot state
// is invalidated when a sync access handle opens or a writable commits. Reads
// started after that fail: FileReader reports the File API error name while
// the promise readers reject with the generic failure Gecko maps stream errors
// to.

function readWithFileReader(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

async function assert_unreadable(t, file, name = 'NotReadableError') {
  await promise_rejects_dom(t, name, readWithFileReader(file));
  await promise_rejects_dom(t, 'AbortError', file.text());
}

directory_test(async (t, root) => {
  const handle = await createFileWithContents('a.txt', 'original', root);
  const snapshot = await handle.getFile();
  assert_equals(await snapshot.text(), 'original');

  const writable = await cleanup_writable(t, await handle.createWritable());
  await writable.write('modified!');
  assert_equals(await snapshot.text(), 'original',
                'Writes to an open writable do not affect the snapshot');

  await writable.close();
  await assert_unreadable(t, snapshot);
  assert_equals(snapshot.size, 'original'.length,
                'Snapshot metadata is fixed at getFile() time');

  const fresh = await handle.getFile();
  assert_equals(await fresh.text(), 'modified!');
  assert_equals(fresh.size, 'modified!'.length);
}, 'Committing a writable makes earlier snapshots unreadable');

directory_test(async (t, root) => {
  const handle = await createFileWithContents('b.txt', 'original', root);
  const snapshot = await handle.getFile();

  const writable = await cleanup_writable(t, await handle.createWritable());
  await writable.write('discarded');
  await writable.abort();

  assert_equals(await snapshot.text(), 'original');
}, 'Aborting a writable keeps earlier snapshots readable');

directory_test(async (t, root) => {
  const handle = await createFileWithContents('c.txt', 'original', root);

  const writable = await cleanup_writable(
      t, await handle.createWritable({keepExistingData: true}));
  await writable.write('modified');

  const snapshot = await handle.getFile();
  assert_equals(await snapshot.text(), 'original',
                'A snapshot taken during a writable sees committed data');

  await writable.close();
  await assert_unreadable(t, snapshot);
}, 'A snapshot taken while a writable is open is unreadable after its commit');

directory_test(async (t, root) => {
  const handle = await createFileWithContents('d.txt', '0123456789', root);
  const snapshot = await handle.getFile();
  const slice = snapshot.slice(2, 6);
  assert_equals(await slice.text(), '2345');

  const writable = await cleanup_writable(t, await handle.createWritable());
  await writable.write('abcdefghij');
  await writable.close();

  await assert_unreadable(t, slice);
}, 'Slices share the snapshot state of their File');

directory_test(async (t, root) => {
  const handle = await createFileWithContents('e.txt', 'original', root);
  const snapshot = await handle.getFile();

  await root.removeEntry('e.txt');

  await assert_unreadable(t, snapshot, 'NotFoundError');
}, 'Removing the entry makes earlier snapshots unreadable');

directory_test(async (t, root) => {
  if (typeof FileSystemSyncAccessHandle === 'undefined') return;

  const handle = await createFileWithContents('f.txt', 'original', root);
  const snapshot = await handle.getFile();
  assert_equals(await snapshot.text(), 'original');

  const sah = await handle.createSyncAccessHandle();
  t.add_cleanup(() => sah.close());
  sah.write(new TextEncoder().encode('modified!'), {at: 0});
  sah.flush();
  await assert_unreadable(t, snapshot);

  sah.truncate(3);
  sah.close();
  await assert_unreadable(t, snapshot);
  assert_equals(snapshot.size, 'original'.length);

  const fresh = await handle.getFile();
  assert_equals(await fresh.text(), 'mod');
  assert_equals(fresh.size, 3);
}, 'Writing through a sync access handle makes earlier snapshots unreadable');

directory_test(async (t, root) => {
  if (typeof FileSystemSyncAccessHandle === 'undefined') return;

  const handle = await createFileWithContents('g.txt', 'original', root);
  const sah = await handle.createSyncAccessHandle();
  t.add_cleanup(() => sah.close());

  const snapshot = await handle.getFile();
  assert_equals(snapshot.name, 'g.txt');
  assert_equals(snapshot.size, 'original'.length);

  sah.write(new TextEncoder().encode('modified!'), {at: 0});
  sah.flush();
  await assert_unreadable(t, snapshot);

  sah.close();
  await assert_unreadable(t, snapshot);
}, 'A snapshot taken while a sync access handle is open is unreadable once it writes');

directory_test(async (t, root) => {
  if (typeof FileSystemSyncAccessHandle === 'undefined') return;

  const handle = await createFileWithContents('h.txt', 'original', root);
  const sah = await handle.createSyncAccessHandle();
  sah.close();

  const snapshot = await handle.getFile();
  assert_equals(await snapshot.text(), 'original');
}, 'A snapshot taken after a sync access handle closed is readable');

directory_test(async (t, root) => {
  if (typeof FileSystemSyncAccessHandle === 'undefined') return;

  const contents = 'A'.repeat(1024 * 1024);
  const handle = await createFileWithContents('i.txt', contents, root);
  const snapshot = await handle.getFile();

  const reader = snapshot.stream().getReader();
  const first = await reader.read();
  assert_false(first.done, 'The first chunk arrives before the write');

  const sah = await handle.createSyncAccessHandle();
  t.add_cleanup(() => sah.close());
  sah.write(new TextEncoder().encode('B'.repeat(4096)), {at: 512 * 1024});
  sah.flush();

  let bytes = first.value.byteLength;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) {
      break;
    }
    bytes += value.byteLength;
  }
  assert_equals(bytes, contents.length,
                'A read in progress runs to completion');

  await assert_unreadable(t, snapshot);
}, 'A read in progress when a sync access handle opens runs to completion');
