# import pytest
# from fastapi.testclient import TestClient
# from zettelfiles.server import app
# import json
# from pathlib import Path
# import shutil
# 
# @pytest.fixture
# def websocket(client):
#     """Create and cleanup websocket connection"""
#     with client.websocket_connect("/ws") as ws:
#         # Add receive with timeout method
#         def receive_json_with_timeout(timeout=5):
#             return ws.receive_json(timeout=timeout)
#         ws.receive_json_with_timeout = receive_json_with_timeout
#         yield ws
#         try:
#             ws.close()
#         except:
#             pass
# 
# @pytest.fixture
# def test_dir(tmp_path):
#     """Create a temporary test directory"""
#     base = tmp_path / "test_zettel"
#     base.mkdir()
# 
#     # Create test files
#     files = {
#         "20230101 First Note.md": "Test content 1",
#         "20230102 Second Note.md": "Test content 2"
#     }
# 
#     for fname, content in files.items():
#         (base / fname).write_text(content)
# 
#     yield base
# 
#     shutil.rmtree(base)
# 
# @pytest.fixture
# def client():
#     """Create test client"""
#     return TestClient(app)
# 
# class TestServer:
#     def test_websocket_connection(self, websocket, test_dir):
#         """Test WebSocket connection and initialization"""
#         # Send initialize command
#         websocket.send_json({
#             "command": "initialize",
#             "params": {"directory": str(test_dir)}
#         })
# 
#         # Get response
#         response = websocket.receive_json_with_timeout()
#         assert response["type"] == "graph_update"
#         assert "data" in response
# 
#     def test_get_graph(self, websocket, test_dir):
#         """Test getting graph data"""
#         websocket.send_json({
#             "command": "get_graph",
#             "params": {"directory": str(test_dir)}
#         })
# 
#         response = websocket.receive_json_with_timeout()
#         assert response["type"] == "success"
#         assert "data" in response
# 
#         # Verify graph contains our test files
#         graph_data = response["data"]
#         assert any("20230101" in node for node in graph_data["all_nodes"])
#         assert any("20230102" in node for node in graph_data["all_nodes"])
# 
#     def test_file_operations(self, websocket, test_dir):
#         """Test file operations through WebSocket"""
#         # Create new file
#         new_file = "20230103 New Note.md"
#         websocket.send_json({
#             "command": "create_file",
#             "params": {
#                 "path": str(test_dir / new_file),
#                 "content": "Test content"
#             }
#         })
# 
#         response = websocket.receive_json_with_timeout()
#         assert response["type"] == "success"
#         assert response["data"]["created"] == True
#         assert (test_dir / new_file).exists()
# 
#     def test_move_files(self, websocket, test_dir):
#         """Test moving files"""
#         # Create target directory
#         target_dir = test_dir / "folder1"
#         target_dir.mkdir()
# 
#         websocket.send_json({
#             "command": "move_files",
#             "params": {
#                 "sourcePaths": [str(test_dir / "20230101 First Note.md")],
#                 "targetDir": str(target_dir)
#             }
#         })
# 
#         response = websocket.receive_json_with_timeout()
#         assert response["type"] == "success"
#         assert "updatedFiles" in response["data"]
#         assert (target_dir / "20230101 First Note.md").exists()
# 
#     def test_error_handling(self, websocket, test_dir):
#         """Test error handling in WebSocket communication"""
#         # Test invalid command
#         websocket.send_json({
#             "command": "invalid_command",
#             "params": {}
#         })
# 
#         response = websocket.receive_json_with_timeout()
#         assert response["type"] == "error"
#         assert "message" in response
# 
#         # Test invalid parameters
#         websocket.send_json({
#             "command": "move_files",
#             "params": {
#                 "sourcePaths": ["nonexistent.md"],
#                 "targetDir": "invalid/path"
#             }
#         })
# 
#         response = websocket.receive_json_with_timeout()
#         assert response["type"] == "error"
#         assert "message" in response
# 
#     def test_watch_changes(self, websocket, test_dir):
#         """Test file watching functionality"""
#         # Start watching directory
#         websocket.send_json({
#             "command": "watch_changes",
#             "params": {"directory": str(test_dir)}
#         })
# 
#         # Create a new file to trigger update
#         new_file = test_dir / "20230104 New Note.md"
#         new_file.write_text("Test content")
# 
#         # Should receive graph update
#         response = websocket.receive_json_with_timeout()
#         assert response["type"] == "graph_update"
#         assert "data" in response
# 
#     def test_get_file_paths(self, websocket, test_dir):
#         """Test getting file paths by node IDs"""
#         websocket.send_json({
#             "command": "get_file_paths",
#             "params": {
#                 "directory": str(test_dir),
#                 "nodeIds": ["20230101", "20230102"]
#             }
#         })
# 
#         response = websocket.receive_json_with_timeout()
#         assert response["type"] == "success"
#         assert "paths" in response["data"]
#         paths = response["data"]["paths"]
#         assert len(paths) == 2
#         assert any("20230101" in path for path in paths)
#         assert any("20230102" in path for path in paths)
