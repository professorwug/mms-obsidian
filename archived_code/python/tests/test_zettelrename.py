import os
import shutil
import tempfile
import unittest
from zettelfiles.zettelrename import rename_and_update_links

class TestZettelRename(unittest.TestCase):
    def setUp(self):
        # Create a temporary directory
        self.test_dir = tempfile.mkdtemp()

        # Create some test files with links
        self.create_test_files()

    def tearDown(self):
        # Clean up the temporary directory
        shutil.rmtree(self.test_dir)

    def create_test_files(self):
        # Create a file to be renamed
        with open(os.path.join(self.test_dir, "01a Test Note.md"), "w") as f:
            f.write("This is a test note that will be renamed")

        # Create files that link to the test note
        files_with_links = {
            "01 Root Note.md": "Here's a link to [[01a Test Note]]",
            "01b Another Note.md": "Reference: [[01a Test Note]] is important",
            "02a Different Note.md": "See [[01a Test Note]] and [[01a Test Note]]",
            "02a01 Come Again.md": "The [[01a Test Note]] is also known as [[01a Test Note|Alias Man]]"
        }

        for filename, content in files_with_links.items():
            with open(os.path.join(self.test_dir, filename), "w") as f:
                f.write(content)

    def test_rename_and_update_links(self):
        old_path = os.path.join(self.test_dir, "01a Test Note.md")
        new_path = os.path.join(self.test_dir, "01a New Name.md")

        success, updated_files = rename_and_update_links(
            self.test_dir,
            old_path,
            new_path,
            "01a",
            "Test Note",
            "01a",
            "New Name"
        )

        self.assertTrue(success)
        self.assertTrue(os.path.exists(new_path))
        self.assertFalse(os.path.exists(old_path))

        # Check that links were updated in other files
        with open(os.path.join(self.test_dir, "01 Root Note.md")) as f:
            self.assertIn("[[01a New Name]]", f.read())

        with open(os.path.join(self.test_dir, "01b Another Note.md")) as f:
            self.assertIn("[[01a New Name]]", f.read())

        with open(os.path.join(self.test_dir, "02a Different Note.md")) as f:
            content = f.read()
            self.assertIn("[[01a New Name]]", content)

        with open(os.path.join(self.test_dir, "02a01 Come Again.md")) as f:
            content = f.read()
            self.assertIn("[[01a New Name|Alias Man]]", content)


    def test_id_change_and_update_links(self):
        """Test changing a note's ID and updating various link formats"""
        # Create a file to be renamed with ID change
        with open(os.path.join(self.test_dir, "01a Test Note.md"), "w") as f:
            f.write("This note will have its ID changed")

        # Create files with different link formats
        files_with_links = {
            "01 Root Note.md": "Here's an ID-only link: [[01a]]",
            "01b Another Note.md": "Full link: [[01a Test Note]]",
            "02a Different Note.md": "Mixed formats: [[01a]] and [[01a Test Note]]",
            "02b Reference.md": "With alias: [[01a Test Note|Custom Name]]"
        }

        for filename, content in files_with_links.items():
            with open(os.path.join(self.test_dir, filename), "w") as f:
                f.write(content)

        # Perform the rename with ID change
        old_path = os.path.join(self.test_dir, "01a Test Note.md")
        new_path = os.path.join(self.test_dir, "01b01 Test Note.md")

        success, updated_files = rename_and_update_links(
            self.test_dir,
            old_path,
            new_path,
            "01a",
            "Test Note",
            "01b01",
            "Test Note"
        )

        self.assertTrue(success)
        self.assertTrue(os.path.exists(new_path))
        self.assertFalse(os.path.exists(old_path))

        # Verify each link format was updated correctly


        with open(os.path.join(self.test_dir, "01b Another Note.md")) as f:
            content = f.read()
            self.assertIn("[[01b01 Test Note]]", content)
            self.assertNotIn("[[01a Test Note]]", content)

        with open(os.path.join(self.test_dir, "02a Different Note.md")) as f:
            content = f.read()
            self.assertIn("[[01b01 Test Note]]", content)  # Full link
            self.assertNotIn("[[01a Test Note]]", content)

        with open(os.path.join(self.test_dir, "02b Reference.md")) as f:
            content = f.read()
            self.assertIn("[[01b01 Test Note|Custom Name]]", content)
            self.assertNotIn("[[01a Test Note|Custom Name]]", content)

    def test_id_and_name_change(self):
        """Test changing both ID and name simultaneously"""
        # Create initial file
        with open(os.path.join(self.test_dir, "01a Original Name.md"), "w") as f:
            f.write("This note will have both ID and name changed")

        # Create files with links
        files_with_links = {
            "01 Root Note.md": "ID-only: [[01a]] and full: [[01a Original Name]]",
            "02a Note.md": "With alias: [[01a Original Name|Alias]]"
        }

        for filename, content in files_with_links.items():
            with open(os.path.join(self.test_dir, filename), "w") as f:
                f.write(content)

        # Perform the rename with both ID and name change
        old_path = os.path.join(self.test_dir, "01a Original Name.md")
        new_path = os.path.join(self.test_dir, "01b01 New Name.md")

        success, updated_files = rename_and_update_links(
            self.test_dir,
            old_path,
            new_path,
            "01a",
            "Original Name",
            "01b01",
            "New Name"
        )

        self.assertTrue(success)
        self.assertTrue(os.path.exists(new_path))
        self.assertFalse(os.path.exists(old_path))

        # Verify links were updated correctly
        with open(os.path.join(self.test_dir, "01 Root Note.md")) as f:
            content = f.read()
            self.assertIn("[[01b01 New Name]]", content)  # Full link
            self.assertNotIn("[[01a Original Name]]", content)

        with open(os.path.join(self.test_dir, "02a Note.md")) as f:
            content = f.read()
            self.assertIn("[[01b01 New Name|Alias]]", content)
            self.assertNotIn("[[01a Original Name|Alias]]", content)

if __name__ == '__main__':
    unittest.main()
