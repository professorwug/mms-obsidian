import pytest
import asyncio
from pathlib import Path
import shutil
from zettelfiles.graph_manager import GraphManager
from watchdog.events import FileCreatedEvent, FileModifiedEvent, FileDeletedEvent

@pytest.fixture
def test_dir(tmp_path):
    """Create a temporary test directory with test files"""
    base = tmp_path / "test_zettel"
    base.mkdir()
    
    # Create test files
    files = {
        "01 Root Note.md": "Link to [[01a03a GGChild Note 2]]",
        "01a Child Note.md": "Link to [[01c Second Note]]",
        "01a03 Grandchild Note.md": "Link to [[01a03 First Note]]",
        "01a03b GGChild Note.md": "Link to [[01c Second Note]]",
        "01a03a GGChild Note 2.md": "Stuff",
        "01b Second Note.md": "Link to [[01a03 First Note]]",
        "01c Second Note.md": "Link to [[01 Root Note]]",
        "02 Bob/nonid note.md": "stuff",
        "02 Bob/02a Bobson.md": "stuff",
    }
    
    for fname, content in files.items():
        fpath = base / fname
        fpath.parent.mkdir(exist_ok=True)
        fpath.write_text(content)
    
    yield base
    
    shutil.rmtree(base)

@pytest.fixture
def graph_manager():
    return GraphManager()

class TestGraphManager:
    def test_initialize_graph(self, graph_manager, test_dir):
        """Test graph initialization from directory"""
        graph = graph_manager.initialize_graph(str(test_dir))
        
        assert graph is not None
        assert len(graph.all_nodes) >= 7
        assert "01 Root Note.md" in graph.all_nodes
        assert "01a Child Note.md" in graph.all_nodes
        assert "01a03 Grandchild Note" in graph.all_nodes

    @pytest.mark.asyncio
    async def test_watch_directory(self, graph_manager, test_dir):
        """Test directory watching and callback"""
        callback_called = asyncio.Event()
        
        async def test_callback(graph):
            callback_called.set()
        
        # Initialize and start watching
        graph_manager.initialize_graph(str(test_dir))
        graph_manager.watch_directory(str(test_dir), test_callback)
        
        # Create a new file to trigger the callback
        new_file = test_dir / "02 Bob/02b bobdaugter.md"
        new_file.write_text("Test content")
        
        # Wait for callback with timeout
        try:
            await asyncio.wait_for(callback_called.wait(), timeout=2.0)
            assert callback_called.is_set()
        finally:
            # Clean up
            if graph_manager.observer:
                graph_manager.observer.stop()
                graph_manager.observer.join()

    def test_update_graph(self, graph_manager, test_dir):
        """Test manual graph update"""
        graph_manager.initialize_graph(str(test_dir))
        initial_node_count = len(graph_manager.graph.all_nodes)
        
        # Add a new file
        new_file = test_dir / "03 New Note.md"
        new_file.write_text("Test content")
        
        # Manual update
        graph_manager.update_graph()
        
        assert len(graph_manager.graph.all_nodes) == initial_node_count + 1
        assert "03" in graph_manager.graph.all_nodes

    @pytest.mark.asyncio
    async def test_file_events(self, graph_manager, test_dir):
        """Test graph updates from different file events"""
        updates = []
        
        async def test_callback(graph):
            updates.append(len(graph.all_nodes))
        
        graph_manager.initialize_graph(str(test_dir))
        graph_manager.watch_directory(str(test_dir), test_callback)
        
        try:
            # Simulate file creation
            event = FileCreatedEvent(str(test_dir / "20230104 New Note.md"))
            graph_manager.graph.update_from_change(event)
            
            # Simulate file modification
            event = FileModifiedEvent(str(test_dir / "20230101 First Note.md"))
            graph_manager.graph.update_from_change(event)
            
            # Simulate file deletion
            event = FileDeletedEvent(str(test_dir / "20230102 Second Note.md"))
            graph_manager.graph.update_from_change(event)
            
            # Wait for callbacks
            await asyncio.sleep(0.5)
            
            assert len(updates) > 0
        finally:
            if graph_manager.observer:
                graph_manager.observer.stop()
                graph_manager.observer.join()

    def test_multiple_graph_managers(self, test_dir):
        """Test multiple GraphManager instances"""
        manager1 = GraphManager()
        manager2 = GraphManager()
        
        graph1 = manager1.initialize_graph(str(test_dir))
        graph2 = manager2.initialize_graph(str(test_dir))
        
        assert len(graph1.all_nodes) == len(graph2.all_nodes)
        assert graph1.all_nodes == graph2.all_nodes
