/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.components.listentopage

import android.content.Context
import android.os.storage.StorageManager
import androidx.core.content.getSystemService
import java.io.IOException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import mozilla.components.feature.listentopage.ListenAction
import mozilla.components.feature.listentopage.ListenState
import mozilla.components.lib.state.Middleware
import mozilla.components.lib.state.Store
import org.mozilla.fenix.GleanMetrics.ListenToPage

/**
 * [Middleware] that records how much room the audio cache has when a listening session starts, since the system may
 * clear the cache directory when storage runs low.
 *
 * @param readStorage Reads the storage of the cache directory, or returns `null` when it cannot. It reads the disk, so
 *   it is called on [ioDispatcher].
 * @param scope The scope the reading is launched in.
 * @param ioDispatcher The dispatcher the reading runs on.
 */
class ListenStorageMiddleware(
    private val readStorage: () -> CacheStorage?,
    private val scope: CoroutineScope,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : Middleware<ListenState, ListenAction> {

    override fun invoke(
        store: Store<ListenState, ListenAction>,
        next: (ListenAction) -> Unit,
        action: ListenAction,
    ) {
        next(action)

        if (action is ListenAction.User.Session.ListenRequested) {
            scope.launch(ioDispatcher) { readStorage()?.record() }
        }
    }
}

/**
 * The storage of the app's cache directory.
 *
 * @property quotaBytes The cache quota the system gives the app. Apps over their quota are cleared first.
 * @property freeBytes The free space on the storage that holds the cache directory.
 */
data class CacheStorage(val quotaBytes: Long, val freeBytes: Long) {

    /** Records both, rounded down so that they are too coarse to tell devices apart. */
    internal fun record() {
        ListenToPage.cacheQuota.accumulate(quotaBytes.toMegabytesRoundedDownTo(QUOTA_STEP_MB))
        ListenToPage.cacheFreeSpace.accumulate(freeBytes.toMegabytesRoundedDownTo(FREE_SPACE_STEP_MB))
    }

    companion object {
        /** Reads the storage of [context]'s cache directory, or returns `null` when the system cannot report it. */
        fun from(context: Context): CacheStorage? {
            val storageManager = context.getSystemService<StorageManager>() ?: return null
            val cacheDir = context.cacheDir
            return try {
                val uuid = storageManager.getUuidForPath(cacheDir)
                CacheStorage(quotaBytes = storageManager.getCacheQuotaBytes(uuid), freeBytes = cacheDir.usableSpace)
            } catch (_: IOException) {
                null
            }
        }
    }
}

private fun Long.toMegabytesRoundedDownTo(stepMb: Long): Long = this / BYTES_PER_MEGABYTE / stepMb * stepMb

private const val BYTES_PER_MEGABYTE = 1024L * 1024L
private const val QUOTA_STEP_MB = 10L
private const val FREE_SPACE_STEP_MB = 100L
