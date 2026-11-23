/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.settings.search

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.tooling.preview.PreviewLightDark
import mozilla.components.compose.base.menu.DropdownMenu
import mozilla.components.compose.base.menu.MenuItem
import mozilla.components.compose.base.text.Text
import org.mozilla.fenix.R
import org.mozilla.fenix.theme.FirefoxTheme

/**
 * Overflow menu of a search engine row in the default search engine settings.
 *
 * @param allowDeletion Whether the "Delete" item is shown.
 * @param isCustomSearchEngine Whether the "Edit" item is shown.
 * @param onItemTapped Invoked with the [Item] the user tapped.
 */
class SearchEngineMenu(
    allowDeletion: Boolean,
    isCustomSearchEngine: Boolean,
    private val onItemTapped: (Item) -> Unit = {},
) {
    sealed class Item {
        object Delete : Item()

        object Edit : Item()
    }

    val items: List<Item> = buildList {
        if (isCustomSearchEngine) add(Item.Edit)
        if (allowDeletion) add(Item.Delete)
    }

    val menuItems: List<MenuItem> = items.map { item ->
        when (item) {
            Item.Edit ->
                MenuItem.TextItem(
                    text = Text.Resource(R.string.search_engine_edit),
                    testTag = EDIT_TEST_TAG,
                    onClick = { onItemTapped(item) },
                )
            Item.Delete ->
                MenuItem.TextItem(
                    text = Text.Resource(R.string.search_engine_delete),
                    level = MenuItem.FixedItem.Level.Critical,
                    testTag = DELETE_TEST_TAG,
                    onClick = { onItemTapped(item) },
                )
        }
    }

    companion object {
        const val MENU_TEST_TAG = "search.engine.menu"
        const val EDIT_TEST_TAG = "search.engine.menu.edit"
        const val DELETE_TEST_TAG = "search.engine.menu.delete"
    }
}

@Composable
internal fun SearchEngineDropdownMenu(
    menu: SearchEngineMenu,
    expanded: Boolean,
    onDismissRequest: () -> Unit,
) {
    DropdownMenu(
        menuItems = menu.menuItems,
        expanded = expanded,
        modifier =
            Modifier.semantics {
                testTagsAsResourceId = true
                testTag = SearchEngineMenu.MENU_TEST_TAG
            },
        onDismissRequest = onDismissRequest,
    )
}

@PreviewLightDark
@Composable
private fun SearchEngineDropdownMenuPreview() {
    FirefoxTheme {
        Box {
            SearchEngineDropdownMenu(
                menu = SearchEngineMenu(allowDeletion = true, isCustomSearchEngine = true),
                expanded = true,
                onDismissRequest = {},
            )
        }
    }
}
