import pytest
from zettelfiles.utils import is_valid_node_id, get_parent_id, get_all_parent_ids

@pytest.mark.parametrize("node_id", [
    "01",      # Root level
    "01a",     # First level
    "01a01",   # Second level
    "01a01b",  # Third level
    "01a01b02", # Fourth level
    "01#",     # Special character
    "01a_", # special character in place of number
    "08r60e!", # longer id with special character  at end
])
def test_valid_node_ids(node_id):
    """Test valid node ID recognition"""
    assert is_valid_node_id(node_id), f"Should accept {node_id}"

@pytest.mark.parametrize("node_id", [
    "",        # Empty
    "1",       # Single digit
    "123",     # Three digits
    "0a",      # Single digit prefix
    "01a1",    # Single digit suffix
    "01aa",    # Two letters
    "a01",     # Letter prefix
    "01a01a2", # Invalid pattern
    "03e@07", # Invalid follow up to special character (which can only come last)
])
def test_invalid_node_ids(node_id):
    """Test invalid node ID recognition"""
    assert not is_valid_node_id(node_id), f"Should reject {node_id}"

@pytest.mark.parametrize("node_id,expected_parent", [
    ("01", ""),        # Root level has no parent
    ("01a", "01"),     # First level parent is root
    ("01a01", "01a"),  # Second level parent
    ("01a01b", "01a01"), # Third level parent
    ("01#", "01"),     # Special character
    ("01#01", "01#"),  # Special character with number
])
def test_get_parent_id(node_id, expected_parent):
    """Test parent ID extraction"""
    assert get_parent_id(node_id) == expected_parent

@pytest.mark.parametrize("node_id,expected_parents", [
    ("01", []),                    # Root level has no parents
    ("01a", ["01"]),              # First level has one parent
    ("01a01", ["01a", "01"]),     # Second level has two parents
    ("01a01b", ["01a01", "01a", "01"]), # Third level has three parents
])
def test_get_all_parent_ids(node_id, expected_parents):
    """Test getting all parent IDs"""
    assert get_all_parent_ids(node_id) == expected_parents
