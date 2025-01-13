# import os
# import shutil
# import tempfile
# import unittest
# from directed_file_graph import build_graph_from_directory, adopt_orphans, FileGraph
# from utils import is_valid_node_id, get_parent_id
# 
# class TestOrphanAdoption(unittest.TestCase):
#     def get_directory_tree(self, path, prefix=""):
#         """Return directory tree structure as string"""
#         result = []
#         result.append(f"{prefix}└── {os.path.basename(path)}")
#         if os.path.isdir(path):
#             prefix += "    "
#             for item in sorted(os.listdir(path)):
#                 item_path = os.path.join(path, item)
#                 if os.path.isdir(item_path):
#                     result.extend(self.get_directory_tree(item_path, prefix))
#                 else:
#                     result.append(f"{prefix}└── {item}")
#         return result
# 
#     def run_test_with_tree(self, test_name):
#         """Capture directory tree before and after graph building and orphan adoption"""
#         before_tree = self.get_directory_tree(self.test_dir)
# 
#         # First build the graph
#         graph = build_graph_from_directory(self.test_dir)
# 
#         # Then explicitly run orphan adoption
#         adopt_orphans(graph, self.test_dir)
# 
#         after_tree = self.get_directory_tree(self.test_dir)
# 
#         # Store the trees in the test instance
#         if not hasattr(self, '_test_trees'):
#             self._test_trees = {}
#         self._test_trees[test_name] = {
#             'before': before_tree,
#             'after': after_tree
#         }
# 
#         return graph
# 
#     def setUp(self):
#         # Create a temporary directory for testing
#         self.test_dir = tempfile.mkdtemp()
#         self._test_trees = {}  # Initialize storage for trees
# 
#         # Create some properly named folders and files first
#         os.makedirs(os.path.join(self.test_dir, "01 Research"))
#         os.makedirs(os.path.join(self.test_dir, "01 Research", "01a Projects"))
# 
#         # Create some test files with proper names
#         with open(os.path.join(self.test_dir, "01 Research", "01a Projects", "01a01 Project Alpha.md"), 'w') as f:
#             f.write("Test content")
#         with open(os.path.join(self.test_dir, "01 Research", "01a Projects", "01a02 Project Beta.md"), 'w') as f:
#             f.write("Test content")
# 
#     def tearDown(self):
#         # Print the directory trees before cleanup
#         if hasattr(self, '_test_trees'):
#             for test_name, trees in self._test_trees.items():
#                 print(f"\n=== {test_name} ===")
#                 print("\nBEFORE FILES:")
#                 print('\n'.join(trees['before']))
#                 print("\nAFTER FILES:")
#                 print('\n'.join(trees['after']))
# 
#         # Clean up the temporary directory
#         shutil.rmtree(self.test_dir)
# 
#     def test_orphan_in_valid_folder(self):
#         # Create an orphan file in a properly named folder
#         orphan_path = os.path.join(self.test_dir, "01 Research", "01a Projects", "orphan_file.md")
#         with open(orphan_path, 'w') as f:
#             f.write("Orphan content")
# 
#         graph = self.run_test_with_tree("Orphan in Valid Folder Test")
# 
#         # The orphan should have been given ID 01a03
#         self.assertTrue("01a03" in graph.all_nodes)
#         self.assertTrue(os.path.exists(os.path.join(
#             self.test_dir, "01 Research", "01a Projects", "01a03 orphan_file.md")))
# 
#     def test_orphan_in_root(self):
#         # Create an orphan file in the root directory
#         orphan_path = os.path.join(self.test_dir, "random_file.md")
#         with open(orphan_path, 'w') as f:
#             f.write("Root orphan content")
# 
#         graph = self.run_test_with_tree("Orphan in Root Test")
# 
#         # Check that the Inbox was created
#         self.assertTrue(os.path.exists(os.path.join(self.test_dir, "00 Inbox")))
#         # The orphan should have been given ID 00a and moved to Inbox
#         self.assertTrue("00a" in graph.all_nodes)
#         self.assertTrue(os.path.exists(os.path.join(
#             self.test_dir, "00 Inbox", "00a random_file.md")))
# 
#     def test_duplicate_id_file(self):
#         # Create a file with the same ID as an existing file
#         duplicate_path = os.path.join(
#             self.test_dir, "01 Research", "01a Projects", "01a01 Duplicate File.md")
#         with open(duplicate_path, 'w') as f:
#             f.write("Duplicate content")
# 
#         graph = self.run_test_with_tree("Duplicate ID Test")
# 
#         # The duplicate should have been given ID 01a0100
#         self.assertTrue("01a01_" in graph.all_nodes)
#         self.assertTrue(os.path.exists(os.path.join(
#             self.test_dir, "01 Research", "01a Projects", "01a01_ Duplicate File.md")))
# 
#     def test_multiple_duplicates(self):
#         # Create multiple files with the same ID
#         base_path = os.path.join(self.test_dir, "01 Research", "01a Projects")
# 
#         # Create several duplicates
#         for i in range(3):
#             with open(os.path.join(base_path, f"01a01 Duplicate{i}.md"), 'w') as f:
#                 f.write(f"Duplicate content {i}")
# 
#         graph = self.run_test_with_tree("Multiple Duplicates Test")
# 
#         # Check that appropriate IDs were assigned
#         self.assertTrue("01a01_" in graph.all_nodes)
#         self.assertTrue("01a01_00" in graph.all_nodes)
#         self.assertTrue("01a01_00_" in graph.all_nodes)
# 
#     def test_orphan_with_links(self):
#         # Create an orphan file that contains links
#         orphan_path = os.path.join(self.test_dir, "01 Research", "01a Projects", "orphan_with_links.md")
#         with open(orphan_path, 'w') as f:
#             f.write("Link to [[01a01 Project Alpha]]")
# 
#         graph = self.run_test_with_tree("Orphan With Links Test")
# 
#         # Check that the file was renamed and links were updated
#         new_file_path = os.path.join(
#             self.test_dir, "01 Research", "01a Projects", "01a03 orphan_with_links.md")
#         self.assertTrue(os.path.exists(new_file_path))
# 
#         # Read the content and verify the link was maintained
#         with open(new_file_path, 'r') as f:
#             content = f.read()
#         self.assertIn("[[01a01 Project Alpha]]", content)
# 
#     def test_nested_orphans(self):
#         # Create nested directories with orphans
#         nested_path = os.path.join(self.test_dir, "01 Research", "01a Projects", "nested_folder")
#         os.makedirs(nested_path)
# 
#         # Create orphans at different levels
#         with open(os.path.join(nested_path, "deep_orphan.md"), 'w') as f:
#             f.write("Deep orphan content")
# 
#         graph = self.run_test_with_tree("Nested Orphans Test")
# 
#         # The orphan should be moved to Inbox since its parent folder isn't properly named
#         self.assertTrue(os.path.exists(os.path.join(
#             self.test_dir, "00 Inbox", "0001 deep_orphan.md")))
# 
#     def test_complete_adoption(self):
#         """Test that all files without IDs are processed during adoption"""
#         # Create a mix of properly named and orphaned files
#         files_to_create = {
#             # Properly named files
#             os.path.join(self.test_dir, "01 Research", "01a Projects", "01a01 Project Alpha.md"): "Content",
#             os.path.join(self.test_dir, "01 Research", "01a02 Research Note.md"): "Content",
# 
#             # Orphans in various locations
#             os.path.join(self.test_dir, "random_note.md"): "Orphan content",
#             os.path.join(self.test_dir, "ideas.md"): "More orphan content",
#             os.path.join(self.test_dir, "01 Research", "untitled.md"): "Nested orphan",
#             os.path.join(self.test_dir, "01 Research", "01a Projects", "draft.md"): "Deep orphan",
#             os.path.join(self.test_dir, "notes.txt"): "Text file orphan",
#             os.path.join(self.test_dir, "01 Research", "temp.txt"): "Another text orphan",
# 
#             # Some with partial IDs or invalid formats
#             os.path.join(self.test_dir, "1 Invalid.md"): "Invalid ID",
#             os.path.join(self.test_dir, "01 No Space.md"): "No space after ID",
#             os.path.join(self.test_dir, "abc Random.md"): "Non-numeric ID"
#         }
# 
#         # Create all test files
#         for filepath, content in files_to_create.items():
#             os.makedirs(os.path.dirname(filepath), exist_ok=True)
#             with open(filepath, 'w') as f:
#                 f.write(content)
# 
#         graph = self.run_test_with_tree("Complete Adoption Test")
# 
#         # Function to check if a filename starts with a valid ID
#         def has_valid_id(filename):
#             parts = filename.split(' ', 1)
#             if len(parts) < 2:
#                 return False
#             potential_id = parts[0]
#             return len(potential_id) >= 2 and potential_id.isdigit()
# 
#         # Check all files in directory recursively
#         remaining_files_without_ids = []
#         for root, _, files in os.walk(self.test_dir):
#             for filename in files:
#                 if not has_valid_id(filename):
#                     remaining_files_without_ids.append(os.path.join(root, filename))
# 
#         # Print detailed information about any remaining files without IDs
#         if remaining_files_without_ids:
#             print("\nFiles still missing IDs after adoption:")
#             for filepath in remaining_files_without_ids:
#                 print(f"- {os.path.relpath(filepath, self.test_dir)}")
# 
#         self.assertEqual(len(remaining_files_without_ids), 0,
#                         f"Found {len(remaining_files_without_ids)} files without proper IDs after adoption")
# 
#         # Verify all files are in the graph
#         all_files = []
#         for root, _, files in os.walk(self.test_dir):
#             for filename in files:
#                 if filename.endswith(('.md', '.txt')):
#                     all_files.append(filename)
# 
#         # Each file should have a corresponding node in the graph
#         for filename in all_files:
#             base_name = os.path.splitext(filename)[0]
#             node_id = base_name.split(' ')[0]
#             self.assertTrue(any(node_id in node for node in graph.all_nodes),
#                            f"File {filename} not properly represented in graph")
# 
#     def test_adoption_with_special_characters(self):
#         """Test that files with special characters are properly handled during adoption"""
#         special_files = {
#             os.path.join(self.test_dir, "test!@#$%.md"): "Special chars",
#             os.path.join(self.test_dir, "spaces in name.md"): "Spaces",
#             os.path.join(self.test_dir, "dots.in.name.md"): "Dots",
#             os.path.join(self.test_dir, "unicode_αβγ.md"): "Unicode",
#             os.path.join(self.test_dir, "comma,semicolon;.md"): "Punctuation"
#         }
# 
#         # Create files
#         for filepath, content in special_files.items():
#             with open(filepath, 'w') as f:
#                 f.write(content)
# 
#         graph = self.run_test_with_tree("Special Characters Test")
# 
#         # Verify all files were processed and have valid IDs
#         for root, _, files in os.walk(self.test_dir):
#             for filename in files:
#                 if filename.endswith('.md'):
#                     base_name = os.path.splitext(filename)[0]
#                     parts = base_name.split(' ', 1)
#                     self.assertTrue(len(parts) >= 2, f"File {filename} not properly renamed with ID")
#                     self.assertTrue(parts[0].isdigit(), f"File {filename} does not have a valid numeric ID")
# 
# if __name__ == '__main__':
#     unittest.main()
