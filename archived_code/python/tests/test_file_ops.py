import pytest
import os
import shutil
from pathlib import Path
from zettelfiles.file_operations import move_files, get_file_paths, create_file
from zettelfiles.file_manager import FileManager
from zettelfiles.graph_manager import GraphManager
from zettelfiles.utils import get_next_available_child_id, get_stable_id_from_folgezettel
from zettelfiles.get_hierarchy import build_combined_graph

@pytest.fixture
def test_dir(tmp_path):
    """Create a temporary test directory with some test files"""
    # Create test directory structure
    base = tmp_path / "test_zettel"
    base.mkdir()
    (base / "folder1").mkdir()
    (base / "folder2").mkdir()

    # Create some test files with content and links
    files = {
        "20230101 First Note.md": "This links to [[20230102 Second Note]]",
        "20230102 Second Note.md": "This links to [[20230101 First Note]]",
        "folder1/20230103 Third Note.md": "Link to [[20230101 First Note]]",
        "folder2/20230104 Fourth Note.md": "No links here"
    }

    for fname, content in files.items():
        fpath = base / fname
        fpath.parent.mkdir(exist_ok=True)
        fpath.write_text(content)

    yield base

    # Cleanup
    shutil.rmtree(base)

@pytest.fixture
async def file_manager(test_dir):
    """Create a FileManager instance with initialized GraphManager"""
    graph_manager = GraphManager()
    graph_manager.initialize_graph(str(test_dir))
    return FileManager(graph_manager)

@pytest.mark.asyncio
class TestFileOperations:
    @pytest.fixture(autouse=True)
    async def setup(self, file_manager):
        """Setup fixture that sets file_manager"""
        self.file_manager = file_manager
        return self.file_manager

    def test_create_file(self, test_dir):
        """Test creating a new file"""
        new_file = test_dir / "20230105 New Note.md"
        content = "Test content"

        assert create_file(str(new_file), content) == True
        assert new_file.exists()
        assert new_file.read_text() == content

    def test_create_file_in_new_directory(self, test_dir):
        """Test creating a file in a new directory"""
        new_file = test_dir / "new_folder" / "20230106 New Note.md"

        assert create_file(str(new_file), "content") == True
        assert new_file.exists()

    # def test_get_file_paths(self, test_dir):
    #     """Test retrieving file paths by node IDs"""
    #     graph = build_combined_graph(str(test_dir))
    #     paths = get_file_paths(str(test_dir), ["20230101", "20230102"], graph)

    #     assert len(paths) == 2
    #     assert any("20230101 First Note.md" in p for p in paths)
    #     assert any("20230102 Second Note.md" in p for p in paths)

    @pytest.mark.asyncio
    async def test_rename_file(self, test_dir):
        """Test renaming a file and updating links"""
        old_path = test_dir / "20230101 First Note.md"
        new_path = test_dir / "20230101 Updated Note.md"

        success, updated_files = await self.file_manager.rename_file(
            str(old_path),
            str(new_path)
        )

        assert success == True
        assert len(updated_files) > 0
        assert new_path.exists()
        assert not old_path.exists()

        # Check if links were updated
        second_note = test_dir / "20230102 Second Note.md"
        content = second_note.read_text()
        assert "20230101 Updated Note" in content

@pytest.mark.asyncio
class TestFileManagerErrors:
    @pytest.fixture(autouse=True)
    async def setup(self, file_manager):
        """Setup fixture that sets file_manager"""
        self.file_manager = file_manager
        return self.file_manager

    @pytest.mark.asyncio
    async def test_move_files_invalid_source(self, test_dir):
        """Test moving non-existent files"""
        with pytest.raises(ValueError):
            await self.file_manager.move_files(
                ["nonexistent_stable_id"],
                "target_stable_id"
            )

    @pytest.mark.asyncio
    async def test_move_files_invalid_target(self, test_dir):
        """Test moving to invalid target directory"""
        source_stable_id = next(iter(self.file_manager.graph_manager.graph.all_nodes))

        success, updated_files = await self.file_manager.move_files(
            [source_stable_id],
            "nonexistent_stable_id"
        )
        assert success == False  # Should fail with invalid target

    @pytest.mark.asyncio
    async def test_create_file_invalid_path(self):
        """Test creating file with invalid path"""
        with pytest.raises(ValueError):
            await self.file_manager.create_file("")

    def test_get_file_paths_empty_ids(self, test_dir):
        """Test get_file_paths with empty ID list"""
        graph = build_combined_graph(str(test_dir))
        paths = get_file_paths(str(test_dir), [], graph)
        assert len(paths) == 0

@pytest.mark.asyncio
class TestFileManagerIntegration:
    @pytest.fixture(autouse=True)
    async def setup(self, file_manager):
        """Async setup fixture that waits for file_manager"""
        self.file_manager = file_manager

    @pytest.mark.asyncio
    async def test_move_and_rename_sequence(self, test_dir):
        """Test sequence of move and rename operations"""
        # First move a file
        source_file = test_dir / "20230101 First Note.md"
        target_dir = test_dir / "folder1"

        success1, _ = await self.file_manager.move_files(
            [str(source_file)],
            str(target_dir)
        )

        # Then rename it
        moved_file = target_dir / "20230101 First Note.md"
        new_name = target_dir / "20230101 Renamed Note.md"

        success2, updated_files = await self.file_manager.rename_file(
            str(moved_file),
            str(new_name)
        )

        assert success1 and success2
        assert new_name.exists()
        assert not moved_file.exists()
        assert not source_file.exists()

        # Verify links were updated in other files
        second_note = test_dir / "20230102 Second Note.md"
        content = second_note.read_text()
        assert "20230101 Renamed Note" in content

    @pytest.mark.asyncio
    async def test_move_files_path_update(self, test_dir):
        """Test that files are moved to correct paths during move operation"""
        # Create test structure
        source_dir = test_dir / "source"
        target_dir = test_dir / "target"
        source_dir.mkdir()
        target_dir.mkdir()

        # Create source file with ID
        source_file = source_dir / "07e02g Source Note.md"
        source_file.write_text("Test content")

        # Create target directory with ID
        target_file = target_dir / "08r Target Dir.md"
        target_file.write_text("Target content")

        # Force graph update to include new files
        self.file_manager.graph_manager.update_graph()
        graph = self.file_manager.graph_manager.graph

        # Get stable IDs from graph
        source_stable_id = get_stable_id_from_folgezettel(graph, '07e02g')
        target_stable_id = get_stable_id_from_folgezettel(graph, '08r')
        # for stable_id, fid in graph.folgezettel_ids.items():
        #     if fid == '07e02g':
        #         source_stable_id = stable_id
        #     elif fid == '08r':
        #         target_stable_id = stable_id

        assert source_stable_id is not None, "Source node not found in graph"
        assert target_stable_id is not None, "Target node not found in graph"

        # Move source to target using stable IDs
        success, updated_files = await self.file_manager.move_files(
            [source_stable_id],
            target_stable_id
        )

        assert success
        # Check that file was moved to correct directory
        expected_path = target_dir / "08r01 Source Note.md"
        assert expected_path.exists()
        assert not source_file.exists()

    @pytest.mark.asyncio
    async def test_move_files_id_update(self, test_dir):
        """Test that file IDs are properly updated during move operation"""
        # Create test structure with existing numbered children
        target_dir = test_dir / "target"
        target_dir.mkdir()

        # Create target and existing children
        files = {
            "08r Target Dir.md": "Target content",
            "08r01 First Child.md": "First child content",
            "08r02 Second Child.md": "Second child content",
        }

        for fname, content in files.items():
            fpath = target_dir / fname
            fpath.write_text(content)

        # Create source file
        source_file = test_dir / "07e02g Source Note.md"
        source_file.write_text("Source content")

        # Force graph update to include new files
        self.file_manager.graph_manager.update_graph()
        graph = self.file_manager.graph_manager.graph

        # Get stable IDs from graph
        source_stable_id = get_stable_id_from_folgezettel(graph, '07e02g')
        target_stable_id = get_stable_id_from_folgezettel(graph, '08r')

        assert source_stable_id is not None, "Source node not found in graph"
        assert target_stable_id is not None, "Target node not found in graph"

        # Move source to target using stable IDs
        success, updated_files = await self.file_manager.move_files(
            [source_stable_id],
            target_stable_id
        )

        assert success
        # Check that file was renamed with next available ID (08r03)
        expected_path = target_dir / "08r03 Source Note.md"
        assert expected_path.exists()
        assert not source_file.exists()

        # Verify graph was updated
        graph = self.file_manager.graph_manager.graph
        moved_node = graph.node_props(source_stable_id)
        assert moved_node['id'] == '08r03'

    @pytest.mark.asyncio
    async def test_move_files_to_directory_node(self, test_dir):
        """Test moving files into a directory node"""
        # Create test structure
        target_dir = test_dir / "01 Target Directory"
        target_dir.mkdir()
        
        # Create source file
        source_file = test_dir / "02a01 Source Note.md"
        source_file.write_text("Test content")

        # Force graph update to include new files
        self.file_manager.graph_manager.update_graph()
        graph = self.file_manager.graph_manager.graph

        # Get stable IDs
        source_stable_id = next(
            stable_id for stable_id, node in graph.nodes.items()
            if node.get('id') == '02a01'
        )
        target_stable_id = next(
            stable_id for stable_id, node in graph.nodes.items()
            if node.get('id') == '01' and node.get('is_directory')
        )

        assert source_stable_id is not None, "Source node not found in graph"
        assert target_stable_id is not None, "Target directory node not found in graph"

        # Move source to target directory
        success, updated_files = await self.file_manager.move_files(
            [source_stable_id],
            target_stable_id
        )

        assert success
        # Check that file was moved to correct directory with correct ID
        expected_path = target_dir / "01a Source Note.md"  # Should get first available child ID
        assert expected_path.exists()
        assert not source_file.exists()

        # Verify graph was updated correctly
        graph = self.file_manager.graph_manager.graph
        moved_node = graph.nodes[source_stable_id]
        assert moved_node['id'] == '01a'  # Should have new ID
        assert moved_node['path'] == os.path.relpath(target_dir, test_dir)  # Should have new path

    @pytest.mark.asyncio
    async def test_move_multiple_files_to_directory(self, test_dir):
        """Test moving multiple files into a directory node"""
        # Create test structure
        target_dir = test_dir / "01 Target Directory"
        target_dir.mkdir()
        
        # Create source files
        source_files = [
            ("02a01 First Note.md", "First content"),
            ("02a02 Second Note.md", "Second content"),
            ("02a03 Third Note.md", "Third content")
        ]
        
        for filename, content in source_files:
            source_file = test_dir / filename
            source_file.write_text(content)

        # Force graph update
        self.file_manager.graph_manager.update_graph()
        graph = self.file_manager.graph_manager.graph

        # Get stable IDs
        source_stable_ids = [
            stable_id for stable_id, node in graph.nodes.items()
            if node.get('id') in ['02a01', '02a02', '02a03']
        ]
        target_stable_id = next(
            stable_id for stable_id, node in graph.nodes.items()
            if node.get('id') == '01' and node.get('is_directory')
        )

        assert len(source_stable_ids) == 3, "Not all source nodes found"
        assert target_stable_id is not None, "Target directory node not found"

        # Move all sources to target directory
        success, updated_files = await self.file_manager.move_files(
            source_stable_ids,
            target_stable_id
        )

        assert success
        # Check that files were moved with sequential IDs
        expected_files = [
            target_dir / "01a First Note.md",
            target_dir / "01b Second Note.md",
            target_dir / "01c Third Note.md"
        ]
        
        for expected_file in expected_files:
            assert expected_file.exists()
        
        for original_file, _ in source_files:
            assert not (test_dir / original_file).exists()

        # Verify graph updates
        graph = self.file_manager.graph_manager.graph
        for stable_id, expected_id in zip(source_stable_ids, ['01a', '01b', '01c']):
            moved_node = graph.nodes[stable_id]
            assert moved_node['id'] == expected_id
            assert moved_node['path'] == os.path.relpath(target_dir, test_dir)

    @pytest.mark.asyncio
    async def test_move_to_directory_with_existing_children(self, test_dir):
        """Test moving files into a directory that already has children"""
        # Create test structure
        target_dir = test_dir / "01 Target Directory"
        target_dir.mkdir()
        
        # Create existing children in target
        existing_files = [
            ("01a Existing First.md", "First existing"),
            ("01b Existing Second.md", "Second existing")
        ]
        
        for filename, content in existing_files:
            target_file = target_dir / filename
            target_file.write_text(content)

        # Create source file
        source_file = test_dir / "02a01 Source Note.md"
        source_file.write_text("Source content")

        # Force graph update
        self.file_manager.graph_manager.update_graph()
        graph = self.file_manager.graph_manager.graph

        # Get stable IDs
        source_stable_id = next(
            stable_id for stable_id, node in graph.nodes.items()
            if node.get('id') == '02a01'
        )
        target_stable_id = next(
            stable_id for stable_id, node in graph.nodes.items()
            if node.get('id') == '01' and node.get('is_directory')
        )

        # Move source to target
        success, updated_files = await self.file_manager.move_files(
            [source_stable_id],
            target_stable_id
        )

        assert success
        # Should get next available ID after existing children
        expected_path = target_dir / "01c Source Note.md"
        assert expected_path.exists()
        assert not source_file.exists()

        # Verify graph update
        graph = self.file_manager.graph_manager.graph
        moved_node = graph.nodes[source_stable_id]
        assert moved_node['id'] == '01c'
        assert moved_node['path'] == os.path.relpath(target_dir, test_dir)
