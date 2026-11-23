/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.settings.search

import mozilla.components.compose.base.menu.MenuItem
import mozilla.components.compose.base.text.Text
import org.junit.Assert.assertEquals
import org.junit.Test
import org.mozilla.fenix.R

class SearchEngineMenuTest {

    @Test
    fun `WHEN the engine is custom and deletable THEN Edit and Delete are shown`() {
        val menu = SearchEngineMenu(allowDeletion = true, isCustomSearchEngine = true)

        assertEquals(listOf(SearchEngineMenu.Item.Edit, SearchEngineMenu.Item.Delete), menu.items)
    }

    @Test
    fun `WHEN the engine is custom but not deletable THEN only Edit is shown`() {
        val menu = SearchEngineMenu(allowDeletion = false, isCustomSearchEngine = true)

        assertEquals(listOf(SearchEngineMenu.Item.Edit), menu.items)
    }

    @Test
    fun `WHEN the engine is deletable but not custom THEN only Delete is shown`() {
        val menu = SearchEngineMenu(allowDeletion = true, isCustomSearchEngine = false)

        assertEquals(listOf(SearchEngineMenu.Item.Delete), menu.items)
    }

    @Test
    fun `WHEN the engine is neither custom nor deletable THEN no item is shown`() {
        val menu = SearchEngineMenu(allowDeletion = false, isCustomSearchEngine = false)

        assertEquals(emptyList<SearchEngineMenu.Item>(), menu.items)
        assertEquals(emptyList<MenuItem>(), menu.menuItems)
    }

    @Test
    fun `GIVEN a custom deletable engine THEN Edit is a default item and Delete a critical one`() {
        val menuItems =
            SearchEngineMenu(allowDeletion = true, isCustomSearchEngine = true)
                .menuItems
                .filterIsInstance<MenuItem.TextItem>()

        assertEquals(
            listOf(
                Text.Resource(R.string.search_engine_edit) to MenuItem.FixedItem.Level.Default,
                Text.Resource(R.string.search_engine_delete) to MenuItem.FixedItem.Level.Critical,
            ),
            menuItems.map { it.text to it.level },
        )
    }

    @Test
    fun `WHEN a menu item is clicked THEN the matching item is reported`() {
        val tappedItems = mutableListOf<SearchEngineMenu.Item>()
        val menu =
            SearchEngineMenu(
                allowDeletion = true,
                isCustomSearchEngine = true,
                onItemTapped = { tappedItems.add(it) },
            )

        menu.menuItems.filterIsInstance<MenuItem.TextItem>().forEach { it.onClick() }

        assertEquals(listOf(SearchEngineMenu.Item.Edit, SearchEngineMenu.Item.Delete), tappedItems)
    }
}
