import pytest
import tempfile
import os
import json
from zettelfiles.get_hierarchy import build_combined_graph, combined_graph_to_dict

@pytest.fixture
def test_dir():
    """Create a temporary directory with test hierarchy"""
    temp_dir = tempfile.mkdtemp()
    
    # Create ID-based hierarchy
    os.makedirs(os.path.join(temp_dir, "01 Math"))
    with open(os.path.join(temp_dir, "01 Math", "01a Calculus.md"), 'w') as f:
        f.write("test content")
    with open(os.path.join(temp_dir, "01 Math", "01b Algebra.md"), 'w') as f:
        f.write("test content")
        
    # Non-ID hierarchy
    os.makedirs(os.path.join(temp_dir, "Regular Folder"))
    with open(os.path.join(temp_dir, "Regular Folder", "normal_file.txt"), 'w') as f:
        f.write("test content")
    os.makedirs(os.path.join(temp_dir, "Regular Folder", "Subfolder"))
    with open(os.path.join(temp_dir, "Regular Folder", "Subfolder", "deep_file.md"), 'w') as f:
        f.write("test content")
        
    # Mixed content in ID folder
    with open(os.path.join(temp_dir, "01 Math", "regular_math_note.txt"), 'w') as f:
        f.write("test content")
    
    yield temp_dir
    
    # Cleanup
    import shutil
    shutil.rmtree(temp_dir)

def test_non_id_graph_structure(test_dir):
    """Test that non-ID graph correctly captures folder hierarchy"""
    # Build the non-ID graph
    non_id_graph = build_combined_graph(test_dir)
    graph_dict = combined_graph_to_dict(non_id_graph)
    
    # Check nodes exist
    assert "Regular Folder" in graph_dict['nodes']
    assert os.path.join("Regular Folder", "normal_file.txt") in graph_dict['nodes']
    assert os.path.join("Regular Folder", "Subfolder") in graph_dict['nodes']
    assert os.path.join("Regular Folder", "Subfolder", "deep_file.md") in graph_dict['nodes']
    
    # Check edges preserve hierarchy
    assert os.path.join("Regular Folder", "Subfolder") in graph_dict['edges']["Regular Folder"]
    assert os.path.join("Regular Folder", "normal_file.txt") in graph_dict['edges']["Regular Folder"]
    assert os.path.join("Regular Folder", "Subfolder", "deep_file.md") in graph_dict['edges'][os.path.join("Regular Folder", "Subfolder")]
    
    # Verify directory flags are correct
    assert graph_dict['nodes']["Regular Folder"]['is_directory']
    assert not graph_dict['nodes'][os.path.join("Regular Folder", "normal_file.txt")]['is_directory']

def test_non_id_files_in_id_folders(test_dir):
    """Test handling of non-ID files within ID-based folders"""
    non_id_graph = build_combined_graph(test_dir)
    graph_dict = combined_graph_to_dict(non_id_graph)
    
    # Check that non-ID file in ID folder is included
    math_note_path = os.path.join("01 Math", "regular_math_note.txt")
    assert math_note_path in graph_dict['nodes']
    assert math_note_path in graph_dict['edges']["01 Math"]
