import os
import sys
import tempfile
from tempfile import TemporaryDirectory
import unittest
from zettelfiles.get_hierarchy import build_combined_graph
from zettelfiles.utils import get_folgezettel_ids_from_graph, get_stable_file_id


def get_node_by_folgezettel(graph, folgezettel_id):
    """Find a node in the graph by its folgezettel ID."""
    for stable_id, node_data in graph['nodes'].items():
        if node_data.get('id') == folgezettel_id:
            return stable_id, node_data
    return None, None

def assert_node_exists_by_folgezettel(graph, folgezettel_id, expected_name=None):
    """Assert that a node with given folgezettel ID exists in the graph."""
    stable_id, node_data = get_node_by_folgezettel(graph, folgezettel_id)
    assert node_data is not None, f"Node with folgezettel ID {folgezettel_id} not found in graph {get_folgezettel_ids_from_graph(graph)}"
    if expected_name:
        assert node_data['name'] == expected_name, f"Node name mismatch for {folgezettel_id}"
    return stable_id

class TestDirectedFileGraph(unittest.TestCase):
    def setUp(self):
        # Print the current test name
        current_test = self.id().split('.')[-1]
        print(f"\n=== Running Test: {current_test} ===", file=sys.stderr)
        # Create a temporary directory for test files
        self.test_dir = tempfile.mkdtemp()

    def tearDown(self):
        # Clean up the temporary directory
        for root, dirs, files in os.walk(self.test_dir, topdown=False):
            for name in files:
                os.remove(os.path.join(root, name))
            for name in dirs:
                os.rmdir(os.path.join(root, name))
        os.rmdir(self.test_dir)

    def create_test_file(self, filepath):
        """Helper to create test files"""
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        with open(filepath, 'w') as f:
            f.write('test content')

    def test_basic_graph_creation(self):
        """Test basic graph creation with a single file"""
        filepath = os.path.join(self.test_dir, "01a Test.txt")
        self.create_test_file(filepath)

        graph = build_combined_graph(self.test_dir)

        # Get stable ID for the file
        stable_id = get_stable_file_id(filepath)

        # Check if node exists with correct data
        assert stable_id in graph['nodes'], "Node not found in graph"
        assert graph['nodes'][stable_id]['id'] == '01a', "Incorrect folgezettel ID"
        assert graph['nodes'][stable_id]['name'] == 'Test', "Incorrect name"

        # Check that the node is tracked in id_nodes
        assert stable_id in graph['id_nodes'], "Node not tracked in id_nodes"

    def test_nested_hierarchy(self):
        """Test nested file hierarchy"""
        child_path = os.path.join(self.test_dir, "01a Parent Dir", "01a05g Child.txt")
        os.makedirs(os.path.dirname(child_path))
        self.create_test_file(child_path)

        graph = build_combined_graph(self.test_dir)

        # Get stable IDs
        child_stable_id = get_stable_file_id(child_path)
        dir_stable_id = next(id for id, data in graph['nodes'].items()
                        if data.get('is_directory') and data.get('id') == '01a')

        # Check nodes exist with correct data
        assert child_stable_id in graph['nodes'], "Child node not found"
        assert graph['nodes'][child_stable_id]['id'] == '01a05g', "Incorrect child folgezettel ID"
        assert graph['nodes'][child_stable_id]['name'] == 'Child', "Incorrect child name"

        # Check directory is properly tracked
        assert dir_stable_id in graph['folder_nodes'], "Directory not tracked in folder_nodes"
        assert graph['nodes'][dir_stable_id]['is_directory'], "Directory not marked as directory"

    def test_multiple_files_same_parent(self):
        """Test multiple files with the same parent"""
        files = [
            "01a05g First.txt",
            "01a05h Second.txt",
            "01a05i Third.txt"
        ]
        file_paths = []
        for f in files:
            path = os.path.join(self.test_dir, f)
            self.create_test_file(path)
            file_paths.append(path)

        graph = build_combined_graph(self.test_dir)

        # Get stable IDs for all files
        stable_ids = [get_stable_file_id(path) for path in file_paths]

        # Check that all nodes exist with correct data
        for path, stable_id in zip(file_paths, stable_ids):
            assert stable_id in graph['nodes'], f"Node not found for {path}"
            assert stable_id in graph['id_nodes'], f"Node not tracked in id_nodes for {path}"

        # Verify all nodes are siblings (share same parent in edges)
        parent_edges = [edges for _, edges in graph['edges'].items()
                       if any(sid in edges for sid in stable_ids)]
        assert len(parent_edges) == 1, "Nodes don't share same parent"

    def test_root_node_creation(self):
        """Test that root nodes are properly created"""
        filepath = os.path.join(self.test_dir, "01a Test.txt")
        self.create_test_file(filepath)

        graph = build_combined_graph(self.test_dir)

        # Check root node exists by folgezettel ID
        root_stable_id = assert_node_exists_by_folgezettel(graph, '01')
        assert root_stable_id in graph['id_nodes'], "Root node not tracked in id_nodes"

        # Check file exists with correct folgezettel ID
        file_stable_id = get_stable_file_id(filepath)
        assert file_stable_id in graph['nodes'], "File node not found"
        assert graph['nodes'][file_stable_id]['id'] == '01a', "Incorrect folgezettel ID"
        assert graph['nodes'][file_stable_id]['name'] == 'Test', "Incorrect name"

    def test_intermediate_parent_creation(self):
        """Test that intermediate parent nodes are properly created"""
        filepath = os.path.join(self.test_dir, "01a05g Test.txt")
        self.create_test_file(filepath)

        graph = build_combined_graph(self.test_dir)

        # Check all intermediate nodes exist by folgezettel ID
        root_id = assert_node_exists_by_folgezettel(graph, '01')
        parent1_id = assert_node_exists_by_folgezettel(graph, '01a')
        parent2_id = assert_node_exists_by_folgezettel(graph, '01a05')

        # Check file node exists with correct data
        file_stable_id = get_stable_file_id(filepath)
        assert file_stable_id in graph['nodes'], "File node not found"
        assert graph['nodes'][file_stable_id]['id'] == '01a05g', "Incorrect folgezettel ID"
        assert graph['nodes'][file_stable_id]['name'] == 'Test', "Incorrect name"

        # Verify hierarchy in edges
        assert file_stable_id in graph['edges'][parent2_id], "File not connected to immediate parent"
        assert parent2_id in graph['edges'][parent1_id], "Parent2 not connected to Parent1"
        assert parent1_id in graph['edges'][root_id], "Parent1 not connected to Root"

    def test_node_info_update(self):
        """Test that node info is properly updated when encountered multiple times"""
        # Create a deep child that will create parent nodes
        child_path = os.path.join(self.test_dir, "01a05g Child.txt")
        self.create_test_file(child_path)
        # Create a file that should update one of those parent nodes
        parent_path = os.path.join(self.test_dir, "01a Parent.txt")
        self.create_test_file(parent_path)

        graph = build_combined_graph(self.test_dir)

        # Get stable IDs
        child_stable_id = get_stable_file_id(child_path)
        parent_stable_id = get_stable_file_id(parent_path)

        # Check that both files exist with correct data
        assert child_stable_id in graph['nodes'], "Child node not found"
        assert graph['nodes'][child_stable_id]['id'] == '01a05g', "Incorrect child folgezettel ID"
        assert graph['nodes'][child_stable_id]['name'] == 'Child', "Incorrect child name"

        assert parent_stable_id in graph['nodes'], "Parent node not found"
        assert graph['nodes'][parent_stable_id]['id'] == '01a', "Incorrect parent folgezettel ID"
        assert graph['nodes'][parent_stable_id]['name'] == 'Parent', "Incorrect parent name"

        # Check that both nodes are tracked in id_nodes
        assert child_stable_id in graph['id_nodes'], "Child not tracked in id_nodes"
        assert parent_stable_id in graph['id_nodes'], "Parent not tracked in id_nodes"

    def test_directory_as_node(self):
        """Test that directories are properly included in the graph"""
        # Create a directory with an ID-based name
        dir_path = os.path.join(self.test_dir, "01a Directory")
        os.makedirs(dir_path)
        child_path = os.path.join(dir_path, "01a05 Child.txt")
        self.create_test_file(child_path)

        graph = build_combined_graph(self.test_dir)

        # Get directory's stable ID (hash-based)
        dir_stable_id = next(id for id, data in graph['nodes'].items()
                        if data.get('is_directory') and data.get('id') == '01a')

        # Check directory node properties
        assert dir_stable_id in graph['folder_nodes'], "Directory not tracked in folder_nodes"
        assert graph['nodes'][dir_stable_id]['is_directory'], "Directory not marked as directory"
        assert graph['nodes'][dir_stable_id]['id'] == '01a', "Incorrect directory folgezettel ID"
        assert graph['nodes'][dir_stable_id]['name'] == 'Directory', "Incorrect directory name"

        # Check child file
        child_stable_id = get_stable_file_id(child_path)
        assert child_stable_id in graph['nodes'], "Child node not found"
        assert graph['nodes'][child_stable_id]['id'] == '01a05', "Incorrect child folgezettel ID"
        assert child_stable_id in graph['edges'][dir_stable_id], "Child not connected to directory"

    def test_directory_as_node_with_non_id(self):
        """Test that directories are properly included in the graph"""
        # Create a directory with an ID-based name
        dir_path = os.path.join(self.test_dir, "01a Directory")
        os.makedirs(dir_path)
        child_path = os.path.join(dir_path, "01a Directory/Sweet Child.txt")
        self.create_test_file(child_path)

        graph = build_combined_graph(self.test_dir)

        # Get directory's stable ID (hash-based)
        dir_stable_id = next(id for id, data in graph['nodes'].items()
                        if data.get('is_directory') and data.get('id') == '01a')

        # Check directory node properties
        assert dir_stable_id in graph['folder_nodes'], "Directory not tracked in folder_nodes"
        assert graph['nodes'][dir_stable_id]['is_directory'], "Directory not marked as directory"
        assert graph['nodes'][dir_stable_id]['id'] == '01a', "Incorrect directory folgezettel ID"
        assert graph['nodes'][dir_stable_id]['name'] == 'Directory', "Incorrect directory name"

        # Check child file
        child_stable_id = get_stable_file_id(child_path)
        assert child_stable_id in graph['nodes'], "Child node not found"
        assert graph['nodes'][child_stable_id]['id'] == '', "Child ID should be empty"
        assert child_stable_id in graph['edges'][dir_stable_id], "Non-ID Child not connected to its containing directory"

    def test_get_roots(self):
        """Test identification of root nodes, and that they are inferred properly from nonroot nodes."""
        files = [
            # "01 Hiya",
            # "02 Shucks",
            "01a First.txt",
            "02b Second.txt",
            "01a05g Child.txt"
        ]
        # Add debug logging
        print("\nCreating test files:")
        for f in files:
            path = os.path.join(self.test_dir, f)
            self.create_test_file(path)
            print(f"Created: {path}")
            # Verify file exists
            assert os.path.exists(path), f"Failed to create {path}"

        print("\nBuilding graph...")
        graph = build_combined_graph(self.test_dir)
        
        # Debug print graph contents
        print("\nGraph nodes:", [node_id for node_id in graph['nodes'].keys()])
        print("Node IDs:", [(node_id, data.get('id')) for node_id, data in graph['nodes'].items()])
        print("Edges:", dict(graph['edges']))

        # Check root nodes exist by folgezettel ID
        root1_id = assert_node_exists_by_folgezettel(graph, '01')
        root2_id = assert_node_exists_by_folgezettel(graph, '02')

        # Verify these are actually roots (no parents in edges)
        all_children = set()
        for edges in graph['edges'].values():
            all_children.update(edges)

        assert root1_id not in all_children, "Root1 has a parent"
        assert root2_id not in all_children, "Root2 has a parent"

        # Verify they have expected children
        assert any(graph['nodes'][child]['id'] == '01a' for child in graph['edges'][root1_id]), "Root1 missing expected child"
        assert any(graph['nodes'][child]['id'] == '02b' for child in graph['edges'][root2_id]), "Root2 missing expected child"


from zettelfiles.zettelrename import rename_and_update_links

class TestZettelRename(unittest.TestCase):
    def setUp(self):
        self.test_dir = TemporaryDirectory()
        self.create_test_files()

    def tearDown(self):
        self.test_dir.cleanup()

    def create_test_files(self):
        # Create a file to be renamed
        with open(os.path.join(self.test_dir.name, "01a Test Note.md"), "w") as f:
            f.write("This is a test note that will be renamed")

        # Create files that link to the test note
        files_with_links = {
            "01 Root Note.md": "Here's a link to [[01a Test Note]] and [[01a Test Note|with alt text]]",
            "01b Another Note.md": "Reference: [[01a Test Note]] is important",
            "02a Different Note.md": "See [[01a]] and [[01a Test Note]]",
            "02b Skip.txt": "This [[01a Test Note]] should be updated",
            "02c Skip.jpg": "This [[01a Test Note]] should NOT be updated"
        }

        for filename, content in files_with_links.items():
            with open(os.path.join(self.test_dir.name, filename), "w") as f:
                f.write(content)

    def test_alt_text_links(self):
        old_path = os.path.join(self.test_dir.name, "01a Test Note.md")
        new_path = os.path.join(self.test_dir.name, "01a New Name.md")

        success, updated_files = rename_and_update_links(
            self.test_dir.name,
            old_path,
            new_path,
            "01a",
            "Test Note",
            "01a",
            "New Name"
        )

        self.assertTrue(success)
        with open(os.path.join(self.test_dir.name, "01 Root Note.md")) as f:
            content = f.read()
            self.assertIn("[[01a New Name]]", content)
            self.assertIn("[[01a New Name|with alt text]]", content)

    def test_file_extension_filtering(self):
        old_path = os.path.join(self.test_dir.name, "01a Test Note.md")
        new_path = os.path.join(self.test_dir.name, "01a New Name.md")

        success, updated_files = rename_and_update_links(
            self.test_dir.name,
            old_path,
            new_path,
            "01a",
            "Test Note",
            "01a",
            "New Name"
        )

        self.assertTrue(success)
        # Check that .txt files were updated
        with open(os.path.join(self.test_dir.name, "02b Skip.txt")) as f:
            self.assertIn("[[01a New Name]]", f.read())

        # Check that .jpg files were NOT updated
        with open(os.path.join(self.test_dir.name, "02c Skip.jpg")) as f:
            self.assertIn("[[01a Test Note]]", f.read())


if __name__ == '__main__':
    unittest.main()
