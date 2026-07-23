# Публикация репозитория и GitHub Pages

## 1. Создать репозиторий

Рекомендуемое имя: `kad-act-collector`.

Параметры:

- видимость: **Public**;
- Issues: включены;
- Discussions, Wiki и Projects: необязательны;
- лицензию и README при создании не добавлять — они уже находятся в пакете.

Загрузите в корень репозитория содержимое этого каталога, включая `.github`, `.gitattributes` и `.gitignore`.

Пример через Git:

```bash
git init
git add .
git commit -m "Public release v0.1.20"
git branch -M main
git remote add origin https://github.com/USERNAME/kad-act-collector.git
git push -u origin main
```

## 2. Включить GitHub Pages

1. Откройте **Settings → Pages**.
2. В разделе **Build and deployment** выберите **Deploy from a branch**.
3. Branch: `main`.
4. Folder: `/docs`.
5. Нажмите **Save** и дождитесь публикации.

При имени репозитория `kad-act-collector` адреса будут такими:

- главная: `https://USERNAME.github.io/kad-act-collector/`;
- политика: `https://USERNAME.github.io/kad-act-collector/privacy-policy.html`;
- соглашение: `https://USERNAME.github.io/kad-act-collector/user-agreement.html`.

В Chrome Web Store укажите адрес `privacy-policy.html` в поле политики конфиденциальности. После публикации откройте ссылку в приватном окне браузера и убедитесь, что она доступна без входа в GitHub.

## 3. Создать GitHub Release

1. Откройте **Releases → Draft a new release**.
2. Tag: `v0.1.20`.
3. Title: `Сборщик судебных актов v0.1.20`.
4. Приложите `release/KAD_Act_Collector_v0.1.20.zip`.
5. В описание перенесите пункты из `CHANGELOG.md`.

## 4. Проверить перед публикацией

- GitHub Actions завершился успешно;
- политика и соглашение открываются по HTTPS;
- Issues включены;
- в репозитории нет `node_modules`, старых релизов, HAR, cookies, токенов и тестовых судебных документов;
- установочный ZIP совпадает с версией, загруженной в Chrome Web Store;
- на странице Chrome Web Store указан рабочий контакт поддержки.
