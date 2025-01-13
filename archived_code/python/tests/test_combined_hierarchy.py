import pytest
import os
import tempfile
import shutil
from zettelfiles.get_hierarchy import build_combined_graph, combined_graph_to_dict
from zettelfiles.utils import is_valid_node_id

@pytest.fixture
def test_dir():
    """Create a temporary test directory"""
    temp_dir = tempfile.mkdtemp()
    
    # Create files with IDs at root
    with open(os.path.join(temp_dir, "01 Root Note.md"), "w") as f:
        f.write("Root note content")
    with open(os.path.join(temp_dir, "01a Child Note.md"), "w") as f:
        f.write("Child note content")
    with open(os.path.join(temp_dir, "03 Another Root.md"), "w") as f:
        f.write("Another root content")

    # Create a regular folder with mixed content
    folder_path = os.path.join(temp_dir, "Regular Folder")
    os.makedirs(folder_path)
    with open(os.path.join(folder_path, "02 Inside Folder.md"), "w") as f:
        f.write("Note inside folder")
    with open(os.path.join(folder_path, "normal_file.txt"), "w") as f:
        f.write("Normal file content")
    
    yield temp_dir
    
    # Cleanup
    shutil.rmtree(temp_dir)

def get_directory_tree(path, prefix=""):
    """Return directory tree structure as string"""
    result = []
    result.append(f"{prefix}└── {os.path.basename(path)}")
    if os.path.isdir(path):
        prefix += "    "
        for item in sorted(os.listdir(path)):
            item_path = os.path.join(path, item)
            if os.path.isdir(item_path):
                result.extend(get_directory_tree(item_path, prefix))
            else:
                result.append(f"{prefix}└── {item}")
    return result

def test_combined_graph_structure(test_dir):
    """Test that the combined graph contains both hierarchies"""
    graph = build_combined_graph(test_dir)
    
    # Test basic structure
    assert "nodes" in graph
    assert "edges" in graph
    assert "id_nodes" in graph
    assert "folder_nodes" in graph

def test_folder_detection(test_dir):
    """Test that folders are properly detected and added"""
    graph = build_combined_graph(test_dir)
    
    # Check folder nodes
    folder_path = "Regular Folder"
    assert folder_path in graph["nodes"]
    assert folder_path in graph["folder_nodes"]
    
    # Check folder node data
    folder_node = graph["nodes"][folder_path]
    assert folder_node["is_directory"]
    assert folder_node["name"] == "Regular Folder"
    assert folder_node["path"] in ["", "."]  # Root level folder path can be empty or "."

def test_id_file_detection(test_dir):
    """Test that files with IDs are properly detected"""
    graph = build_combined_graph(test_dir)
        
    # Look for nodes with specific folgezettel IDs
    found_ids = set()
    for stable_id, node_data in graph["nodes"].items():
        if node_data["id"]:  # If node has a folgezettel ID
            found_ids.add(node_data["id"])
        
    assert "01" in found_ids
    assert "01a" in found_ids
    assert "02" in found_ids
    assert "03" in found_ids

    def test_folder_relationships(self):
        """Test that folder relationships are properly established"""
        graph = self.run_test_with_tree("Folder Relationships Test")
        
        folder_path = "Regular Folder"
        inside_file_path = os.path.join("Regular Folder", "02 Inside Folder.md")
        
        # Check that the folder contains the ID file
        self.assertIn(inside_file_path, graph["edges"].get(folder_path, set()))

    def test_id_relationships(self):
        """Test that ID-based relationships are maintained"""
        graph = self.run_test_with_tree("ID Relationships Test")
        
        # Check that 01 is parent of 01a
        root_note_path = "01 Root Note.md"
        child_note_path = "01a Child Note.md"
        self.assertIn(child_note_path, graph["edges"].get(root_note_path, set()))

    def test_combined_graph_to_dict(self):
        """Test the conversion to dictionary format"""
        graph = self.run_test_with_tree("Combined Graph to Dict Test")
        dict_graph = combined_graph_to_dict(graph)
        
        # Check that sets are converted to lists
        self.assertTrue(isinstance(dict_graph["id_nodes"], list))
        self.assertTrue(isinstance(dict_graph["folder_nodes"], list))
        
        # Check that edge values are converted to lists
        # Find a path that actually exists in the edges
        self.assertTrue(len(dict_graph["edges"]) > 0, "No edges found in graph")
        # Take the first available edge path
        some_path = next(iter(dict_graph["edges"].keys()))
        self.assertTrue(isinstance(dict_graph["edges"][some_path], list))

    def test_edge_cases(self):
        """Test various edge cases"""
        # Create some edge case files
        edge_case_dir = os.path.join(self.test_dir, "Edge Cases")
        os.makedirs(edge_case_dir)
        
        # File with ID in deeply nested folder
        nested_dir = os.path.join(edge_case_dir, "Level1", "Level2")
        os.makedirs(nested_dir)
        with open(os.path.join(nested_dir, "04 Nested Note.md"), "w") as f:
            f.write("Nested note content")
            
        # Empty folder
        os.makedirs(os.path.join(edge_case_dir, "Empty Folder"))
        
        graph = self.run_test_with_tree("Edge Cases Test")
        
        # Test nested file is properly connected
        nested_path = os.path.join("Edge Cases", "Level1", "Level2")
        nested_file_path = os.path.join(nested_path, "04 Nested Note.md")
        self.assertIn(nested_file_path, graph["edges"].get(nested_path, set()))
        
        # Test empty folder is included
        empty_folder_path = os.path.join("Edge Cases", "Empty Folder")
        self.assertIn(empty_folder_path, graph["folder_nodes"])

    def test_file_metadata(self):
        """Test that file metadata is properly preserved"""
        graph = self.run_test_with_tree("File Metadata Test")
        
        # Find the actual path for the root note
        root_note_path = next(
            path for path in graph["nodes"] 
            if path.endswith("01 Root Note.md")
        )
        
        # Check ID file metadata
        node_01 = graph["nodes"][root_note_path]
        self.assertEqual(node_01["extension"], ".md")
        self.assertEqual(node_01["name"], "Root Note")
        
        # Check folder metadata
        folder_path = "Regular Folder"
        folder_node = graph["nodes"][folder_path]
        self.assertTrue(folder_node["is_directory"])
        self.assertEqual(folder_node["name"], "Regular Folder")
