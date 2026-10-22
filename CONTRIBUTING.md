# Contributing to Google Meet Call Timer

Thank you for your interest in contributing to Google Meet Call Timer! This guide outlines the process for contributing code, reporting issues, and submitting feature requests.

## Ways to Contribute

- **Report Bugs**: Submit bug reports via GitHub Issues with steps to reproduce.
- **Suggest Features**: Share ideas to enhance functionality, performance, or UI design.
- **Submit Pull Requests**: Implement bug fixes or new features and open a Pull Request.

## Development Workflow

1. **Fork the Repository**: Create a personal fork on GitHub.
2. **Clone the Fork**: Clone your fork to your local environment.
3. **Create a Feature Branch**: Create a new branch for your feature or fix.
4. **Load Local Extension in Chrome**:
   - Open Chrome extensions page (`chrome://extensions`).
   - Enable Developer Mode.
   - Click **Load unpacked** and select the repository folder.
5. **Make Changes & Test**: Ensure timer HUD overlay and popup history work reliably on Google Meet calls.
6. **Commit & Push**: Commit your changes with a descriptive commit message.
7. **Open a Pull Request**: Submit your PR targeting the `main` branch.

## Code Guidelines

- Write clean, modern JavaScript (ES6+).
- Keep CSS rules scoped to avoid conflicting with Google Meet native styles.
- Ensure all extension features comply with Chrome Manifest V3 guidelines.

## License

By contributing, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).
